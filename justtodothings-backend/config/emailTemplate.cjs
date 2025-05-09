"use strict";

const RESET_PASSWORD_HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Your justtodothings Password</title>
    <style type="text/css">
        /* Base styles */
        body, html {
            margin: 0;
            padding: 0;
            font-family: monospace;
            line-height: 1.5;
            color: #000000;
            background-color: #ffffff;
        }
        
        /* Container styles */
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        
        /* Header styles */
        .header {
            padding: 20px 0;
            text-align: left;
            border-bottom: 1px solid rgba(0, 0, 0, 0.2);
        }
        
        .logo {
            font-size: 24px;
            font-weight: normal;
            margin: 0;
            padding: 0;
        }
        
        /* Content styles */
        .content {
            padding: 30px 0;
        }
        
        h1 {
            font-size: 24px;
            font-weight: normal;
            margin: 0 0 20px 0;
        }
        
        p {
            margin: 0 0 20px 0;
        }
        
        /* Button styles */
        .button-container {
            padding: 20px 0;
            text-align: center;
        }
        
        .button {
            display: inline-block;
            padding: 10px 20px;
            background-color: #ffffff;
            color: #000000;
            border: 1px solid #000000;
            text-decoration: none;
            font-family: monospace;
            font-size: 14px;
            text-align: center;
            transition: background-color 0.3s, color 0.3s;
        }
        
        .button:hover {
            background-color: #000000;
            color: #ffffff;
        }
        
        /* Security notice */
        .security-notice {
            padding: 15px;
            margin: 20px 0;
            border: 1px solid rgba(0, 0, 0, 0.2);
            font-size: 12px;
            color: rgba(0, 0, 0, 0.7);
        }
        
        /* Footer styles */
        .footer {
            padding: 20px 0;
            text-align: center;
            font-size: 12px;
            color: rgba(0, 0, 0, 0.6);
            border-top: 1px solid rgba(0, 0, 0, 0.2);
        }
        
        .footer p {
            margin: 5px 0;
        }
        
        /* Responsive styles */
        @media only screen and (max-width: 600px) {
            .container {
                width: 100%;
                padding: 10px;
            }
            
            .content {
                padding: 20px 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 class="logo">justtodothings</h1>
        </div>
        
        <div class="content">
            <h1>reset your password</h1>
            
            <p>hello,</p>
            
            <p>we've received a request to reset your password for your justtodothings account. if you didn't make this request, you can safely ignore this email.</p>
            
            <div class="button-container">
                <a href="{{RESET_PASSWORD_URL}}" class="button">reset your password</a>
            </div>
            
            <div class="security-notice">
                <p>this password reset link will expire in 24 hours. if you need a new reset link after that time, please visit the forgot password page again.</p>
                <p>if you didn't request a password reset, please contact us immediately at <a href="mailto:contact@justtodothings.com">contact@justtodothings.com</a>.</p>
            </div>
            
            <p>if the button above doesn't work, copy and paste the following URL into your browser:</p>
            <p style="word-break: break-all; font-size: 12px;">{{RESET_PASSWORD_URL}}</p>
        </div>
        
        <div class="footer">
            <p>&copy; 2025 justtodothings. all rights reserved.</p>
            <p>this is an automated message, please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
`;

const VERIFICATION_EMAIL_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verify Your justtodothings Email</title>
    <style type="text/css">
        /* Base styles */
        body, html {
            margin: 0;
            padding: 0;
            font-family: monospace;
            line-height: 1.5;
            color: #000000;
            background-color: #ffffff;
        }
        
        /* Container styles */
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        
        /* Header styles */
        .header {
            padding: 20px 0;
            text-align: left;
            border-bottom: 1px solid rgba(0, 0, 0, 0.2);
        }
        
        .logo {
            font-size: 24px;
            font-weight: normal;
            margin: 0;
            padding: 0;
        }
        
        /* Content styles */
        .content {
            padding: 30px 0;
        }
        
        h1 {
            font-size: 24px;
            font-weight: normal;
            margin: 0 0 20px 0;
        }
        
        p {
            margin: 0 0 20px 0;
        }
        
        /* Button styles */
        .button-container {
            padding: 20px 0;
            text-align: center;
        }
        
        .button {
            display: inline-block;
            padding: 10px 20px;
            background-color: #ffffff;
            color: #000000;
            border: 1px solid #000000;
            text-decoration: none;
            font-family: monospace;
            font-size: 14px;
            text-align: center;
            transition: background-color 0.3s, color 0.3s;
        }
        
        .button:hover {
            background-color: #000000;
            color: #ffffff;
        }
        
        /* Info box */
        .info-box {
            padding: 15px;
            margin: 20px 0;
            border: 1px solid rgba(0, 0, 0, 0.2);
            font-size: 12px;
            color: rgba(0, 0, 0, 0.7);
        }
        
        /* Footer styles */
        .footer {
            padding: 20px 0;
            text-align: center;
            font-size: 12px;
            color: rgba(0, 0, 0, 0.6);
            border-top: 1px solid rgba(0, 0, 0, 0.2);
        }
        
        .footer p {
            margin: 5px 0;
        }
        
        /* Responsive styles */
        @media only screen and (max-width: 600px) {
            .container {
                width: 100%;
                padding: 10px;
            }
            
            .content {
                padding: 20px 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 class="logo">justtodothings</h1>
        </div>
        
        <div class="content">
            <h1>verify your email</h1>
            
            <p>hello,</p>
            
            <p>thanks for signing up for justtodothings. please verify your email address to complete your registration and start organizing your tasks.</p>
            
            <div class="button-container">
                <a href="{{VERIFICATION_URL}}" class="button">verify my email</a>
            </div>
            
            <div class="info-box">
                <p>this verification link will expire in 24 hours. if you need a new verification link after that time, please sign in to request a new one.</p>
                <p>if you didn't create an account with justtodothings, please ignore this email or contact us at <a href="mailto:contact@justtodothings.com">contact@justtodothings.com</a> if you have concerns.</p>
            </div>
            
            <p>if the button above doesn't work, copy and paste the following URL into your browser:</p>
            <p style="word-break: break-all; font-size: 12px;">{{VERIFICATION_URL}}</p>
        </div>
        
        <div class="footer">
            <p>&copy; 2025 justtodothings. all rights reserved.</p>
            <p>this is an automated message, please do not reply to this email.</p>
        </div>
    </div>
</body>
</html>
`;

module.exports = {
    RESET_PASSWORD_HTML_TEMPLATE,
    VERIFICATION_EMAIL_TEMPLATE
};