# Termux Deployment Guide (Android)

Follow these steps to run your WhatsApp bot 24/7 on your Android device using Termux.

## 1. Initial Setup
Install Termux from F-Droid (not Play Store) and run the following:
```bash
pkg update && pkg upgrade
pkg install nodejs git chromium 
```

## 2. Clone and Install
```bash
git clone <your-repo-url>
cd Whatsappbot
npm install
```

## 3. Configuration
Make sure your phone number and your mom's number are in the `AUTHORIZED_NUMBERS` list in `index.js`:
```javascript
const AUTHORIZED_NUMBERS = [
    '96590967095@c.us', 
    '96566154015@c.us',
];
```

## 4. Run the Bot
```bash
node index.js
```
Scan the QR code that appears in the terminal using your WhatsApp (Linked Devices).

## 5. Keep it Running 24/7
- **Wake Lock**: Swipe down the Termux notification and click "Acquire Wake Lock".
- **Battery Optimization**: Disable battery optimization for the Termux app in your phone settings.
- **Background Run**: Use `pm2` if you want it to restart automatically:
  ```bash
  npm install -g pm2
  pm2 start index.js --name "fb-bot"
  pm2 save
  ```
