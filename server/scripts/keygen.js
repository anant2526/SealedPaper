// Prints fresh secrets for your .env file. Run: npm run keygen
import crypto from 'node:crypto';
console.log(`MASTER_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
