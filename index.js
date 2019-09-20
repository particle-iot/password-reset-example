// Example Particle product password reset application
const express = require('express')
const path = require('path')
const querystring = require('querystring');

const pug = require('pug'); // https://pugjs.org/api/getting-started.html

const Particle = require('particle-api-js'); // https://docs.particle.io/reference/SDKs/javascript/
const particle = new Particle(); 

// Axios is used for making the change customer email API call because it's not currently
// supported by particle-api-js. 
const axios = require('axios').default; // https://github.com/axios/axios

const nodemailer = require('nodemailer'); // https://nodemailer.com/about/

const uuidv4 = require('uuid/v4');

// Postgresql database
const { Pool } = require('pg'); // https://node-postgres.com/

if (!process.env.DATABASE_URL) {
	console.log('missing required DATABASE_URL');
	process.exit(1);
}
// Use ssl for cloud-deployed instances, but for localhost it probably does not support SSL.
const poolConfig = {connectionString: process.env.DATABASE_URL};
poolConfig.ssl = !poolConfig.connectionString.includes('localhost');
const pool = new Pool(poolConfig);

const PORT = process.env.PORT || 5000;

// This is how long tokens stay valid. You could make this longer, maybe 24 hours, if 
// you wanted to.
const EXPIRATION_MINUTES = process.env.EXPIRATION_MINUTES || 30; 

// SMTP server configuration
const transportConfig = {};
transportConfig.host = process.env.SMTP_SERVER;
transportConfig.secure = Boolean(process.env.SMTP_SECURE || 'true');
transportConfig.port = parseInt(process.env.SMTP_PORT || '587');
transportConfig.auth = {user:process.env.SMTP_USERNAME,pass:process.env.SMTP_PASSWORD};

if (!transportConfig.host || !transportConfig.auth.user || !transportConfig.auth.pass) {
	console.log('missing required SMTP_SERVER, SMTP_USERNAME, or SMTP_PASSWORD. Probably should also set SMTP_SECURE and SMTP_PORT.');
	process.exit(1);
}

// console.log('transportConfig', transportConfig);

let transporter = nodemailer.createTransport(transportConfig);

const EMAIL_FROM=process.env.EMAIL_FROM
if (!EMAIL_FROM) {
	console.log('missing required EMAIL_FROM');
	process.exit(1);
}

const WEB_URL=process.env.WEB_URL || 'http://localhost:5000/';
console.log('WEB_URL=' + WEB_URL);

const PARTICLE_ACCESS_TOKEN=process.env.PARTICLE_ACCESS_TOKEN;
const PARTICLE_PRODUCT_ID=process.env.PARTICLE_PRODUCT_ID;

if (!PARTICLE_ACCESS_TOKEN || !PARTICLE_PRODUCT_ID) {
	console.log('missing required PARTICLE_ACCESS_TOKEN or PARTICLE_PRODUCT_ID');
	process.exit(1);
}

// Verify PARTICLE_ACCESS_TOKEN
particle.getProduct({product: PARTICLE_PRODUCT_ID, auth: PARTICLE_ACCESS_TOKEN}).then(
	function(data){
		console.log('PARTICLE_ACCESS_TOKEN and PARTICLE_PRODUCT_ID (' + PARTICLE_PRODUCT_ID + ') appear valid', data.body);
	},
	function(err) {
		console.log('PARTICLE_ACCESS_TOKEN or PARTICLE_PRODUCT_ID are invalid');
		process.exit(1);
	}
);

const app = express();

// Use pug as the views engine https://pugjs.org/api/getting-started.html
app.set('views', './views');
app.set('view engine', 'pug');

const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true }));


app.get('/reset1', async (req, res) => {
	try {
		const email = req.query.email;
		if (!email) {
			console.log('remoteAddr=' + req.connection.remoteAddress + ' missing email in reset1');
			res.status(400).send('invalid request').end();
			return;
		}
			
		// We don't validate the email address here. The reason is that you want the same response 
		// if the email address exists in the database or not. Otherwise, you could use the password
		// reset feature to determine if any arbitrary email address has a Particle account.
		// After the email is received and a link clicked, then we can provide a more detailed
		// response, because we know they have access to that email account and are just not
		// probing random email addresses.
		
		const now = new Date();
		const expires = new Date(now.getTime() + EXPIRATION_MINUTES * 60 * 1000); 
		
		const client = await pool.connect()
		
		const resultDelete = await client.query('DELETE FROM tokens WHERE expires<$1', [now]);

		
		const token = uuidv4();
		console.log('token=' + token + ' expires=' + expires.toString());
				
		const result = await client.query('INSERT INTO tokens(email, token, expires) VALUES($1, $2, $3) ON CONFLICT(email) DO UPDATE SET token=excluded.token,expires=excluded.expires', [email, token, expires]);

		const link = WEB_URL + 'reset2?token=' + token; 
		
		const emailOptions = {link:link, title:'Password reset request'};

		// The text version of the email is also built in pug. The <p> are removed and the
		// </p> are converted to actual newlines. Avoid using other features other than
		// p in the emailText.pug file.
		let emailText = pug.renderFile('./views/emailText.pug', emailOptions);
		emailText = emailText.replace(/<p>/g, '');
		emailText = emailText.replace(/<\/p>/g, '\n');
		
		// emailHtml does not have those limitions, you can use normal HTML features there
		const emailHtml = pug.renderFile('./views/emailHtml.pug', emailOptions);
		
		// Send email!
		let info = await transporter.sendMail({
	        from: EMAIL_FROM, // sender address
	        to: email, // list of receivers
	        subject: emailOptions.title, // Subject line
	        text: emailText, // plain text body
	        html: emailHtml // html body
	    });
		// console.log("info", info);
		
		const emailAccepted = info.accepted.length > 0;
		
		const logMsg = 'email ' + (emailAccepted ? 'accepted' : 'rejected'); 
		
		const resultLogs = await client.query('INSERT INTO logs(kind, remoteAddr, email, msg, ts) VALUES($1, $2, $3, $4, $5)', 
				[1, req.connection.remoteAddress, email, logMsg, now]);
		
		console.log('remoteAddr=' + req.connection.remoteAddress + ' email=' + email + ' ' + logMsg);
		
		client.release();
		res.render('checkEmail', {});
	} catch (err) {
		console.error(err);
		res.status(500).send('request failed').end();
	}
});

app.get('/reset2', async (req, res) => {
	try {
		const token = req.query.token;
		if (!token) {
			console.log('remoteAddr=' + req.connection.remoteAddress + ' missing token in reset2');
			res.status(400).send('invalid request').end();
			return;
		}
					
		const client = await pool.connect();
				
		const result = await client.query('SELECT email FROM tokens WHERE token=$1', [token]);

		const renderOptions = {};
		let logMsg = '';
		let email = '';
		let success = false;
		
		if (result.rows.length == 1) {
			email = result.rows[0].email;
			
			console.log('remoteAddr=' + req.connection.remoteAddress + ' token=' + token + ' email=' + email + ' valid');
			success = true;
		}
		else {
			// Invalid token (expired, already used, etc.)
			console.log('remoteAddr=' + req.connection.remoteAddress + ' token=' + token + ' invalid');
			
			renderOptions.status = 'Unable to reset password. The request link may have expired or has already been used.';
			logMsg = 'invalid token';
		}
		

		if (success) {
			res.render('reset2', {token:req.query.token});
		}
		else {
			const now = new Date();
			
			const resultLogs = await client.query('INSERT INTO logs(kind, remoteAddr, email, msg, ts) VALUES($1, $2, $3, $4, $5)', 
					[2, req.connection.remoteAddress, email, logMsg, now]);

			client.release();
			res.render('reset3', renderOptions);			
		}		
	} catch (err) {
		console.error(err);
		res.status(500).send('request failed').end();
	}
	
});

app.post('/reset3', async (req, res) => {
	try {
		const token = req.body.token;
		const password = req.body.password;
		if (!token || !password) {
			console.log('remoteAddr=' + req.connection.remoteAddress + ' missing token or password in reset3');
			res.status(400).send('invalid request').end();
			return;
		}
					
		const client = await pool.connect();
				
		const result = await client.query('SELECT email FROM tokens WHERE token=$1', [token]);

		let logMsg = '';
		let email = '';
		
		// console.log('result.rows', result.rows);

		renderOptions = {};
		
		if (result.rows.length == 1) {
			// Normal response
			email = result.rows[0].email;
			
			// Reset password
			// Particle’s API existing authenticated PUT /v1/products/:id/customers/:customerEmail {password: <new_password>, access_token: <your_token>}.
			const url = 'https://api.particle.io/v1/products/' + PARTICLE_PRODUCT_ID + '/customers/' + email;
			const particleResult = await axios.put(url, querystring.stringify({password:password, access_token:PARTICLE_ACCESS_TOKEN}));
		    
			// console.log('Particle result status=' + particleResult.status, particleResult.data);
			
			if (particleResult.status == 200) {
				// Success
				renderOptions.status = 'Your password has been reset!';
				logMsg = 'success';
				console.log('remoteAddr=' + req.connection.remoteAddress + ' token=' + token + ' email=' + email + ' password reset successfully!');
			}
			else {
				// Failure
				renderOptions.status = 'Unable to reset password. Your account email may not be valid for this product.';
				logMsg = 'failed status=' + particleResult.status;
				console.log('remoteAddr=' + req.connection.remoteAddress + ' token=' + token + ' email=' + email + ' not accepted for product ' + PARTICLE_PRODUCT_ID);
			}
			
			// Delete token
			await client.query('DELETE FROM tokens WHERE token=$1', [token]);			
		}
		else {
			// Invalid token (expired, already used, etc.)
			renderOptions.status = 'Unable to reset password. The request link may have expired or has already been used.';
			logMsg = 'invalid token';
			console.log('remoteAddr=' + req.connection.remoteAddress + ' token=' + token + ' not in database');
		}
		

		const now = new Date();
		
		const resultLogs = await client.query('INSERT INTO logs(kind, remoteAddr, email, msg, ts) VALUES($1, $2, $3, $4, $5)', 
				[3, req.connection.remoteAddress, email, logMsg, now]);

		client.release();
		res.render('reset3', renderOptions);
	} catch (err) {
		console.error(err);
		res.status(500).send('request failed').end();
	}
});

app.get('/', function(req, res, next) {
	console.log('remoteAddr=' + req.connection.remoteAddress + ' requested index page');
	res.render('index', {});
});

// Serve static files in the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Last step: listen for connections
app.listen(PORT, () => console.log(`Listening on ${ PORT }`));

