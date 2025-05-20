import * as fs from 'fs';
import bs58 from 'bs58';
import * as path from 'path';

// The secret key in base58 format
const secretKeyBase58: string = 'YOUR_SECRET_KEY_HERE';

try {
    // Decode the base58 secret key
    const secretKey: Buffer = Buffer.from(bs58.decode(secretKeyBase58));
    
    // Path to anchor directory (one level up + anchor folder)
    const anchorDirPath: string = path.join(__dirname, '..', 'anchor');
    
    // Convert to array format that Solana expects and write to the anchor directory
    const keypairPath: string = path.join(anchorDirPath, 'deploy-keypair.json');
    fs.writeFileSync(keypairPath, '[' + Array.from(secretKey).toString() + ']', 'utf8');
    
    console.log(`Keypair file created successfully at ${keypairPath}`);
} catch (error) {
    console.error('Error creating keypair file:', error);
} 