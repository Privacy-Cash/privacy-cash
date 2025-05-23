# ZKCash Encryption

This directory contains tools and utilities for the ZKCash project, including the encryption system.

## Encryption System

The encryption system provides a way to securely encrypt and decrypt UTXO (Unspent Transaction Output) data for the ZKCash privacy system. This follows a similar approach to the one used in Tornado Cash Nova.

### Key Features

- **Deterministic Key Derivation**: Generates encryption keys deterministically from Solana wallet keypairs
- **Deterministic UTXO Private Keys**: Creates private keys for UTXOs based on the encryption key
- **Privacy-Preserving**: Only the owner of the UTXOs can decrypt their data
- **Simple API**: Easy-to-use encryption and decryption methods

### How It Works

1. A user signs a constant message with their Solana wallet private key
2. The first 31 bytes of the signature become the encryption key
3. This key is used for AES-256-CBC encryption/decryption of UTXO data
4. The same key can generate deterministic UTXO private keys for use in transactions
5. Encrypted data can be safely stored on-chain

### Usage

```typescript
import { EncryptionService } from './encryption';
import { Keypair } from '@solana/web3.js';
import { Keypair as UtxoKeypair } from './models/keypair';
import { Utxo } from './models/utxo';

// Create a new service
const encryptionService = new EncryptionService();

// Generate an encryption key from a wallet keypair
const myKeypair = Keypair.fromSecretKey(...);
encryptionService.generateEncryptionKey(myKeypair);

// Generate a deterministic UTXO private key
const privKey = encryptionService.getUtxoPrivateKey();
// Optional: Use salt to generate different private keys
const privKey2 = encryptionService.getUtxoPrivateKey('utxo2');

// Create UTXO keypairs for use in transactions
const lightWasm = await WasmFactory.getInstance();
const utxoKeypair = new UtxoKeypair(privKey, lightWasm);
const utxo = new Utxo({ lightWasm, amount: '1000000000', keypair: utxoKeypair });

// Encrypt UTXO data
const utxoData = JSON.stringify({ 
  amount: '1000000000', 
  blinding: '123456789',
  privateKey: privKey 
});
const encryptedData = encryptionService.encrypt(utxoData);

// Later, decrypt the data
const decryptedData = encryptionService.decrypt(encryptedData);
const parsedData = JSON.parse(decryptedData.toString());
```

### Security Considerations

- The encryption key never leaves the client
- Only the user with the correct wallet can derive the right encryption key
- The same keypair will always generate the same encryption key (deterministic)
- UTXO private keys are deterministically derived from the encryption key
- Multiple UTXOs can be created by using different salt values
- Only encrypted data is stored on-chain

## Example

See `examples/encryption-example.ts` for a full example of using the encryption service.

## Running Tests

Tests for the encryption system can be run using Jest:

```bash
npm test
``` 