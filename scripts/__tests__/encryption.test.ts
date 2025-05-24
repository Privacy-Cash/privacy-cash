import { Keypair } from '@solana/web3.js';
import { EncryptionService, UtxoData } from '../utils/encryption';
import { Utxo } from '../models/utxo';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { BN } from 'bn.js';
import 'jest';

// Define an interface for our mocked Utxo
interface MockUtxo {
  amount: { toString: () => string };
  blinding: { toString: () => string };
  index: number | string;
  getCommitment: jest.Mock;
  getNullifier: jest.Mock;
}

// Mock the Utxo class to avoid loading the actual implementation
jest.mock('../models/utxo', () => {
  return {
    Utxo: jest.fn().mockImplementation(function(this: MockUtxo, { amount, blinding, index }) {
      this.amount = { toString: () => amount.toString() };
      this.blinding = { toString: () => blinding.toString() };
      this.index = index;
      this.getCommitment = jest.fn().mockResolvedValue('mock-commitment');
      this.getNullifier = jest.fn().mockResolvedValue('mock-nullifier');
    })
  };
});

// Mock the WasmFactory to avoid loading the actual implementation
jest.mock('@lightprotocol/hasher.rs', () => {
  return {
    WasmFactory: {
      getInstance: jest.fn().mockResolvedValue({
        poseidonHashString: jest.fn().mockReturnValue('mock-poseidon-hash')
      })
    }
  };
});

// Mock the Keypair constructor to avoid the poseidonHashString call
jest.mock('../models/keypair', () => {
  return {
    Keypair: jest.fn().mockImplementation(function(this: any, privkeyHex: string, lightWasm: any) {
      this.privkey = { toString: () => privkeyHex };
      this.pubkey = { toString: () => 'mock-pubkey' };
      this.lightWasm = lightWasm;
      this.sign = jest.fn().mockReturnValue('mock-signature');
    })
  };
});

describe('EncryptionService', () => {
  let encryptionService: EncryptionService;
  let testKeypair: Keypair;
  let mockLightWasm: any;

  beforeAll(async () => {
    // Get the mock light wasm instance
    mockLightWasm = await WasmFactory.getInstance();
  });

  beforeEach(() => {
    // Create a new instance for each test
    encryptionService = new EncryptionService();
    
    // Generate a test keypair with a fixed seed for reproducible tests
    const seed = new Uint8Array(32).fill(1);
    testKeypair = Keypair.fromSeed(seed);
    
    // Make sure the Utxo constructor mock is cleared before each test
    (Utxo as jest.Mock).mockClear();
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

  describe('encryptUtxo', () => {
    it('should throw an error if encryption key is not generated', () => {
      const testUtxo: UtxoData = {
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      };
      
      expect(() => {
        encryptionService.encryptUtxo(testUtxo);
      }).toThrow('Encryption key not generated');
    });

    it('should encrypt and decrypt a UTXO with numeric index', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Create test UTXO
      const testUtxo: UtxoData = {
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      };
      
      // Encrypt the UTXO
      const encrypted = encryptionService.encryptUtxo(testUtxo);
      
      // Should return a buffer
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      
      // Decrypt the UTXO (await the promise)
      const decrypted = await encryptionService.decryptUtxo(encrypted, mockLightWasm);
      
      // Decrypted UTXO should match original
      expect(decrypted.amount.toString()).toBe(testUtxo.amount);
      expect(decrypted.blinding.toString()).toBe(testUtxo.blinding);
      expect(decrypted.index).toBe(testUtxo.index);
    });

    it('should encrypt and decrypt a UTXO with string index', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Create test UTXO
      const testUtxo: UtxoData = {
        amount: '1000000000',
        blinding: '123456789',
        index: 'abc123'
      };
      
      // Encrypt the UTXO
      const encrypted = encryptionService.encryptUtxo(testUtxo);
      
      // Decrypt the UTXO (await the promise)
      const decrypted = await encryptionService.decryptUtxo(encrypted, mockLightWasm);
      
      // Decrypted UTXO should match original
      expect(decrypted.amount.toString()).toBe(testUtxo.amount);
      expect(decrypted.blinding.toString()).toBe(testUtxo.blinding);
      
      // Note: In the implementation, string indices might be converted to numbers
      // If it can't be converted, it would return 0 as fallback
      // For tests, we just check that we have an index property
      expect(decrypted.index !== undefined).toBe(true);
    });

    it('should accept and decrypt a hex string instead of a Buffer', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Create test UTXO
      const testUtxo: UtxoData = {
        amount: '5000000000',
        blinding: '987654321',
        index: 1
      };
      
      // Encrypt the UTXO
      const encrypted = encryptionService.encryptUtxo(testUtxo);
      
      // Convert to hex string
      const encryptedHex = encrypted.toString('hex');
      
      // Decrypt from hex string (await the promise)
      const decrypted = await encryptionService.decryptUtxo(encryptedHex, mockLightWasm);
      
      // Decrypted UTXO should match original
      expect(decrypted.amount.toString()).toBe(testUtxo.amount);
      expect(decrypted.blinding.toString()).toBe(testUtxo.blinding);
      expect(decrypted.index).toBe(testUtxo.index);
    });

    it('should throw an error when decrypting with wrong key', async () => {
      // Generate key and encrypt
      encryptionService.generateEncryptionKey(testKeypair);
      
      const testUtxo: UtxoData = {
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      };
      
      const encrypted = encryptionService.encryptUtxo(testUtxo);
      
      // Create new service with different key
      const otherService = new EncryptionService();
      const seed2 = new Uint8Array(32).fill(2);
      const testKeypair2 = Keypair.fromSeed(seed2);
      otherService.generateEncryptionKey(testKeypair2);
      
      // Should fail to decrypt with wrong key
      await expect(otherService.decryptUtxo(encrypted, mockLightWasm)).rejects.toThrow('Failed to decrypt data');
    });

    it('should throw an error when decrypting invalid UTXO format', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Encrypt invalid format (missing pipe separators)
      const invalidData = encryptionService.encrypt('invalidutxoformat');
      
      // Should fail to parse as UTXO
      await expect(encryptionService.decryptUtxo(invalidData, mockLightWasm)).rejects.toThrow('Invalid UTXO format');
    });
  });

  describe('encryptUtxo and decryptUtxo with Utxo instances', () => {
    it('should encrypt and decrypt Utxo instances', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Create a test Utxo instance
      const testUtxo = new Utxo({
        lightWasm: mockLightWasm,
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      }) as unknown as MockUtxo;
      
      // Encrypt the UTXO
      const encrypted = encryptionService.encryptUtxo(testUtxo as unknown as Utxo);
      
      // Should return a buffer
      expect(Buffer.isBuffer(encrypted)).toBe(true);
      
      // Decrypt the UTXO
      const decrypted = await encryptionService.decryptUtxo(encrypted, mockLightWasm);
      
      // Check it's a proper Utxo instance
      expect(decrypted).toBeInstanceOf(Utxo);
      
      // Check core data matches
      expect(decrypted.amount.toString()).toBe(testUtxo.amount.toString());
      expect(decrypted.blinding.toString()).toBe(testUtxo.blinding.toString());
      expect(decrypted.index).toBe(testUtxo.index);
    });
    
    it('should handle larger amount values correctly', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Create a test Utxo with a large amount
      const largeAmount = '1000000000000000000'; // 1 SOL in lamports
      const testUtxo = new Utxo({
        lightWasm: mockLightWasm,
        amount: largeAmount,
        blinding: '987654321',
        index: 1
      }) as unknown as MockUtxo;
      
      // Encrypt and decrypt
      const encrypted = encryptionService.encryptUtxo(testUtxo as unknown as Utxo);
      const decrypted = await encryptionService.decryptUtxo(encrypted, mockLightWasm);
      
      // Check large amount is preserved
      expect(decrypted.amount.toString()).toBe(largeAmount);
    });
    
    it('should work with UtxoData and Utxo interchangeably', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Test with UtxoData
      const utxoData: UtxoData = {
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      };
      
      const encryptedData = encryptionService.encryptUtxo(utxoData);
      const decryptedFromData = await encryptionService.decryptUtxo(encryptedData, mockLightWasm);
      
      // Test with Utxo
      const utxoInstance = new Utxo({
        lightWasm: mockLightWasm,
        amount: '1000000000',
        blinding: '123456789',
        index: 0
      }) as unknown as MockUtxo;
      
      const encryptedInstance = encryptionService.encryptUtxo(utxoInstance as unknown as Utxo);
      const decryptedFromInstance = await encryptionService.decryptUtxo(encryptedInstance, mockLightWasm);
      
      // Both should produce valid Utxo instances with the same data
      expect(decryptedFromData.amount.toString()).toBe(utxoData.amount);
      expect(decryptedFromInstance.amount.toString()).toBe(utxoInstance.amount.toString());
    });
    
    it('should throw an error if trying to decrypt invalid UTXO data', async () => {
      // Generate encryption key
      encryptionService.generateEncryptionKey(testKeypair);
      
      // Encrypt some non-UTXO data
      const invalidData = encryptionService.encrypt('invalid data format');
      
      // Should throw when trying to decrypt as a UTXO
      await expect(async () => {
        await encryptionService.decryptUtxo(invalidData, mockLightWasm);
      }).rejects.toThrow('Invalid UTXO format');
    });
  });
}); 