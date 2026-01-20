require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

const app = express();

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

axios.interceptors.request.use(request => {
    console.log(`\n🔵 [REQUEST] ${request.method.toUpperCase()} ${request.url}`);
    if (request.data) {
        const safeData = { ...request.data };
        if (safeData.password) safeData.password = "***";
        if (safeData.newPassword) safeData.newPassword = "***";
        if (safeData.NewPassword) safeData.NewPassword = "***";
        console.log("   Payload:", JSON.stringify(safeData));
    }
    return request;
});

axios.interceptors.response.use(response => {
    console.log(`🟢 [RESPONSE] Status: ${response.status}`);
    const dataStr = JSON.stringify(response.data);
    console.log("   Data:", dataStr.substring(0, 500) + (dataStr.length > 500 ? "..." : ""));
    return response;
}, error => {
    console.log(`🔴 [ERROR] ${error.message}`);
    if (error.response) console.log("   Data:", JSON.stringify(error.response.data));
    return Promise.reject(error);
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: true,
    debug: true
});

const limitRequest = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "Too many requests."
});

async function getAmpSession() {
    try {
        const response = await axios.post(`${process.env.AMP_URL}/API/Core/Login`, {
            username: process.env.AMP_USER,
            password: process.env.AMP_PASS,
            token: "",
            rememberMe: false
        });
        return response.data.sessionID || null;
    } catch (error) {
        return null;
    }
}

async function findUser(sessionId, targetUsername) {
    const config = {
        headers: {
            'Authorization': `Bearer ${sessionId}`,
            'Accept': 'application/json'
        }
    };

    try {
        const listRes = await axios.post(`${process.env.AMP_URL}/API/Core/GetAllAMPUserInfo`, {}, config);
        const userList = listRes.data.result || listRes.data;

        if (!Array.isArray(userList)) {
            console.log("\n⚠️  WARNING: API did not return an array.");
            return null;
        }

        const matchedUser = userList.find(u => {
            const nameCandidate = u.username || u.Username || u.Name;
            return nameCandidate && nameCandidate.toLowerCase() === targetUsername.toLowerCase();
        });

        if (!matchedUser) {
            console.log(`   User '${targetUsername}' not found.`);
            return null;
        }

        const validUsername = matchedUser.username || matchedUser.Username || matchedUser.Name;
        if (!validUsername) {
            console.error("❌ CRITICAL: Found user object, but no valid username field.");
            console.error("   Object Dump:", JSON.stringify(matchedUser));
            return null;
        }

        const email = matchedUser.emailAddress || matchedUser.EmailAddress || matchedUser.email;
        if (!email) {
            console.log(`   User found (${validUsername}), but has no email.`);
            return null;
        }

        return { username: validUsername, email };
    } catch (err) {
        return null;
    }
}

function maskEmail(email) {
    const [user, domain] = email.split("@");
    if (user.length <= 2) return `${user[0]}***@${domain}`;
    return `${user.slice(0, 2)}***@${domain}`;
}

app.post('/request', limitRequest, async (req, res) => {
    const usernameInput = req.body.username.trim();
    console.log(`\n🚀 Starting Reset Process for: ${usernameInput}`);

    const sessionId = await getAmpSession();
    if (!sessionId) return res.render('request', { message: "Login Failed", type: "error" });

    const user = await findUser(sessionId, usernameInput);

    if (user && user.email && user.username) {
        console.log(`   Generating token for verified user: ${user.username}`);

        const token = jwt.sign(
            { username: String(user.username) },
            process.env.SESSION_SECRET,
            { expiresIn: '15m' }
        );

        const resetLink = `${req.protocol}://${req.get('host')}/reset/${token}`;

        try {
            await transporter.sendMail({
                from: process.env.SMTP_FROM,
                to: user.email,
                subject: 'Reset Password',
                html: `
                <div style="background-color: #0f172a; padding: 40px; font-family: sans-serif; color: #f1f5f9; text-align: center; border-radius: 10px;">
                    <img src="https://ik.imagekit.io/nzbuwt9by/hxshost-slim.png" alt="Hxshost Logo" style="width: 200px; margin-bottom: 30px;">
                    <h2 style="color: #6366f1; margin-bottom: 10px;">Password Reset Request</h2>
                    <p style="color: #94a3b8; font-size: 16px;">Hello <strong>${user.username}</strong>,</p>
                    <p style="color: #94a3b8; font-size: 14px; margin-bottom: 30px;">We received a request to reset your Hxshost Game Panel password. Click the button below to secure your account.</p>
                    <a href="${resetLink}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">Reset Password</a>
                    <p style="color: #64748b; font-size: 11px; margin-top: 40px;">This link will expire in 15 minutes. If you did not request this, please ignore this email.</p>
                </div>
                `
            });

            console.log("✅ Email dispatched.");
            return res.render('request', {
                message: `Link sent to ${maskEmail(user.email)}`,
                type: "success"
            });

        } catch (e) {
            console.error("❌ Email Error:", e.message);
        }
    } else {
        console.warn("⚠️  Failed to generate token: User, Email, or Username missing.");
    }

    res.render('request', { message: "If account exists, link was sent.", type: "success" });
});

app.get('/', (req, res) => res.render('request', { message: null, type: null }));

app.get('/reset/:token', (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, process.env.SESSION_SECRET);
        return res.render('reset', {
            token: req.params.token,
            username: decoded.username,
            message: null
        });
    } catch {
        return res.send("Invalid or expired link.");
    }
});

app.post('/reset', async (req, res) => {
    const { token, password } = req.body;

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.SESSION_SECRET);
    } catch (e) {
        return res.send("Invalid or expired token.");
    }

    if (!decoded.username) {
        return res.send("Invalid token payload.");
    }

    const sessionId = await getAmpSession();
    if (!sessionId) return res.send("System Error: Backend Unavailable");

    try {
        const resetRes = await axios.post(
            `${process.env.AMP_URL}/API/Core/ResetUserPassword`,
            {
                Username: decoded.username,
                NewPassword: password
            },
            { headers: { Authorization: `Bearer ${sessionId}` } }
        );


	const data = resetRes.data;

	const success =
	    data === true ||
	    data?.success === true ||
	    data?.result === true ||
	    data?.Status === true;

	if (success) {
	    return res.render('success');
	}

        return res.send("Update failed. Password may not meet requirements.");
    } catch (e) {
        console.error("❌ Reset Failed:", e.response?.data || e.message);
        return res.send("Update failed. Password may be too weak or rejected.");
    }
});

app.listen(process.env.PORT, () =>
    console.log(`Auth Portal running on port ${process.env.PORT}`)
);
