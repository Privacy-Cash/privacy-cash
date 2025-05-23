import { Keypair } from '@solana/web3.js';
import { EncryptionService } from '../encryption';
import 'jest';

describe('EncryptionService', () => {
  let encryptionService: EncryptionService;
  let testKeypair: Keypair;

  beforeEach(() => {
    // Create a new instance for each test
    encryptionService = new EncryptionService();
    
    // Generate a test keypair with a fixed seed for reproducible tests
    const seed = new Uint8Array(32).fill(1);
    testKeypair = Keypair.fromSeed(seed);
  });

  describe('generateEncryptionKey', () => {
    it('should generate a deterministic key from a keypair', () => {
      const key1 = encryptionService.generateEncryptionKey(testKeypair);
      
      // Reset and regenerate
      encryptionService.resetEncryptionKey();
      const key2 = encryptionService.generateEncryptionKey(testKeypair);
      
      // Keys should be 31 bytes
      expect(key1.length).toBe(31);
      expect(key2.length).toBe(31);
      
      // Deterministic - same keypair should produce same key
      expect(Buffer.from(key1).toString('hex')).toBe(Buffer.from(key2).toString('hex'));
    });

    it('should set the internal encryption key', () => {
      expect(encryptionService.hasEncryptionKey()).toBe(false);
      encryptionService.generateEncryptionKey(testKeypair);
      expect(encryptionService.hasEncryptionKey()).toBe(true);
    });

    it('should generate different keys for different keypairs', () => {
      const key1 = encryptionService.generateEncryptionKey(testKeypair);
      
      // Create a different keypair
      const seed2 = new Uint8Array(32).fill(2);
      const testKeypair2 = Keypair.fromSeed(seed2);
      
      // Reset and regenerate with different keypair
      encryptionService.resetEncryptionKey();
      const key2 = encryptionService.generateEncryptionKey(testKeypair2);
      
      // Keys should be different
      expect(Buffer.from(key1).toString('hex')).not.toBe(Buffer.from(key2).toString('hex'));
    });
  });

  describe('encrypt', () => {
    it('should throw an error if encryption key is not generated', () => {
      expect(() => {
        encryptionService.encrypt('test data');
      }).toThrow('Encryption key not generated');
    });

    it('should encrypt data as a buffer', () => {
      encryptionService.generateEncryptionKey(testKeypair);
      const originalData = 'test data';
      const encrypted = encryptionService.encrypt(originalData);
      
      // Should return a buffer
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      
      // Encrypted data should be longer than original (includes IV)
      expect(encrypted.length).toBeGreaterThan(originalData.length);
      
      // Encrypted data should not be the same as original
      expect(encrypted.toString()).not.toBe(originalData);
    });

    it('should encrypt Buffer data', () => {
      encryptionService.generateEncryptionKey(testKeypair);
      const originalData = Buffer.from([1, 2, 3, 4, 5]);
      const encrypted = encryptionService.encrypt(originalData);
      
      // Should return a buffer
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      
      // Encrypted data should not be the same as original
      expect(encrypted.toString('hex')).not.toBe(originalData.toString('hex'));
    });
  });

  describe('decrypt', () => {
    it('should throw an error if encryption key is not generated', () => {
      const fakeEncrypted = Buffer.from('fake encrypted data');
      
      expect(() => {
        encryptionService.decrypt(fakeEncrypted);
      }).toThrow('Encryption key not generated');
    });

    it('should decrypt previously encrypted data', () => {
      encryptionService.generateEncryptionKey(testKeypair);
      
      const originalData = 'This is some secret UTXO data';
      const encrypted = encryptionService.encrypt(originalData);
      const decrypted = encryptionService.decrypt(encrypted);
      
      // Decrypted data should match original
      expect(decrypted.toString()).toBe(originalData);
    });

    it('should decrypt binary data correctly', () => {
      encryptionService.generateEncryptionKey(testKeypair);
      
      const originalData = Buffer.from([0, 1, 2, 3, 255, 254, 253]);
      const encrypted = encryptionService.encrypt(originalData);
      const decrypted = encryptionService.decrypt(encrypted);
      
      // Decrypted data should match original
      expect(decrypted.toString('hex')).toBe(originalData.toString('hex'));
    });

    it('should throw error when decrypting with wrong key', () => {
      // Generate key and encrypt
      encryptionService.generateEncryptionKey(testKeypair);
      const originalData = 'secret data';
      const encrypted = encryptionService.encrypt(originalData);
      
      // Create new service with different key
      const otherService = new EncryptionService();
      const seed2 = new Uint8Array(32).fill(2);
      const testKeypair2 = Keypair.fromSeed(seed2);
      otherService.generateEncryptionKey(testKeypair2);
      
      // Should fail to decrypt with wrong key
      expect(() => {
        otherService.decrypt(encrypted);
      }).toThrow('Failed to decrypt data');
    });
  });

  describe('encryption key management', () => {
    it('should reset the encryption key', () => {
      encryptionService.generateEncryptionKey(testKeypair);
      expect(encryptionService.hasEncryptionKey()).toBe(true);
      
      encryptionService.resetEncryptionKey();
      expect(encryptionService.hasEncryptionKey()).toBe(false);
    });

    it('should correctly report whether key is present', () => {
      expect(encryptionService.hasEncryptionKey()).toBe(false);
      encryptionService.generateEncryptionKey(testKeypair);
      expect(encryptionService.hasEncryptionKey()).toBe(true);
    });
  });

  describe('end-to-end workflow', () => {
    it('should support the full encrypt-decrypt workflow', () => {
      // Generate encryption key
      const key = encryptionService.generateEncryptionKey(testKeypair);
      expect(key.length).toBe(31);
      
      // Encrypt some UTXO data
      const utxoData = JSON.stringify({
        amount: '1000000000',
        blinding: '123456789',
        pubkey: 'abcdef1234567890'
      });
      
      const encrypted = encryptionService.encrypt(utxoData);
      
      // Verify encrypted data is different
      expect(encrypted.toString()).not.toContain(utxoData);
      
      // Decrypt and verify
      const decrypted = encryptionService.decrypt(encrypted);
      expect(decrypted.toString()).toBe(utxoData);
      
      // Parse the JSON to verify structure remained intact
      const parsedData = JSON.parse(decrypted.toString());
      expect(parsedData.amount).toBe('1000000000');
      expect(parsedData.blinding).toBe('123456789');
      expect(parsedData.pubkey).toBe('abcdef1234567890');
    });
  });

  describe('getUtxoPrivateKey', () => {
    it('should throw an error if encryption key is not generated', () => {
      expect(() => {
        encryptionService.getUtxoPrivateKey();
      }).toThrow('Encryption key not generated');
    });

    it('should generate a deterministic private key from the encryption key', () => {
      // Generate the encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Generate two private keys from the same encryption key
      const privKey1 = encryptionService.getUtxoPrivateKey();
      const privKey2 = encryptionService.getUtxoPrivateKey();
      
      // Private keys should be strings starting with 0x
      expect(typeof privKey1).toBe('string');
      expect(typeof privKey2).toBe('string');
      expect(privKey1.startsWith('0x')).toBe(true);
      
      // Same encryption key should produce same private key
      expect(privKey1).toBe(privKey2);
    });

    it('should generate different private keys when using different salts', () => {
      // Generate the encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Generate private keys with different salts
      const privKey1 = encryptionService.getUtxoPrivateKey('salt1');
      const privKey2 = encryptionService.getUtxoPrivateKey('salt2');
      
      // Different salts should produce different private keys
      expect(privKey1).not.toBe(privKey2);
    });

    it('should generate different private keys for different users', () => {
      // User 1
      encryptionService.generateEncryptionKey(testKeypair);
      const user1PrivKey = encryptionService.getUtxoPrivateKey();
      
      // User 2 with different encryption key
      const seed2 = new Uint8Array(32).fill(2);
      const testKeypair2 = Keypair.fromSeed(seed2);
      
      const user2Service = new EncryptionService();
      user2Service.generateEncryptionKey(testKeypair2);
      const user2PrivKey = user2Service.getUtxoPrivateKey();
      
      // Different users should get different private keys
      expect(user1PrivKey).not.toBe(user2PrivKey);
    });
  });

  describe('end-to-end workflow with UTXO keypair', () => {
    it('should support the full encryption workflow with a generated keypair', () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Generate a UTXO private key
      const utxoPrivKey = encryptionService.getUtxoPrivateKey();
      
      // Simulate creating a custom UTXO format
      const utxoData = JSON.stringify({
        amount: '1000000000',
        blinding: '123456789',
        privateKey: utxoPrivKey
      });
      
      const encrypted = encryptionService.encrypt(utxoData);
      
      // Decrypt and verify
      const decrypted = encryptionService.decrypt(encrypted);
      expect(decrypted.toString()).toBe(utxoData);
      
      // Parse the JSON to verify structure remained intact
      const parsedData = JSON.parse(decrypted.toString());
      expect(parsedData.privateKey).toBe(utxoPrivKey);
    });
  });
}); 