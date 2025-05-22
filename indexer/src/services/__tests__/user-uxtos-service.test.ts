import { userUxtosService } from '../user-uxtos-service';

describe('UserUxtosService', () => {
  beforeEach(() => {
    // Reset the userUxtosService before each test
    // Access private properties for testing
    (userUxtosService as any).initialized = false;
    (userUxtosService as any).encryptedOutputs = new Set();
    
    // Initialize the service
    userUxtosService.initialize();
  });

  describe('initialization', () => {
    it('should initialize the service', () => {
      expect((userUxtosService as any).initialized).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.size).toBe(0);
    });

    it('should skip initialization if already initialized', () => {
      // Set a value to check it's not reset on second initialization
      (userUxtosService as any).encryptedOutputs.add('test');
      
      // Re-initialize
      userUxtosService.initialize();
      
      expect((userUxtosService as any).initialized).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.size).toBe(1);
    });
  });

  describe('addEncryptedOutput', () => {
    it('should add a string encrypted output', () => {
      const output = '0123456789abcdef0123456789abcdef';
      
      const result = userUxtosService.addEncryptedOutput(output);
      
      expect(result).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.has(output)).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.size).toBe(1);
    });

    it('should add a Uint8Array encrypted output', () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const expectedHex = Buffer.from(bytes).toString('hex');
      
      const result = userUxtosService.addEncryptedOutput(bytes);
      
      expect(result).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.has(expectedHex)).toBe(true);
      expect((userUxtosService as any).encryptedOutputs.size).toBe(1);
    });

    it('should not add a duplicate encrypted output', () => {
      const output = '0123456789abcdef0123456789abcdef';
      
      // Add first time
      userUxtosService.addEncryptedOutput(output);
      
      // Try to add again
      const result = userUxtosService.addEncryptedOutput(output);
      
      expect(result).toBe(false);
      expect((userUxtosService as any).encryptedOutputs.size).toBe(1);
    });

    it('should throw error if not initialized', () => {
      // Reset the service initialization flag
      (userUxtosService as any).initialized = false;
      
      expect(() => userUxtosService.addEncryptedOutput('test')).toThrow(
        'UserUxtosService not initialized'
      );
    });
  });

  describe('hasEncryptedOutput', () => {
    it('should return true for existing string output', () => {
      const output = '0123456789abcdef0123456789abcdef';
      
      // Add the output
      userUxtosService.addEncryptedOutput(output);
      
      // Check if it exists
      const result = userUxtosService.hasEncryptedOutput(output);
      
      expect(result).toBe(true);
    });

    it('should return true for existing Uint8Array output', () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      
      // Add the output
      userUxtosService.addEncryptedOutput(bytes);
      
      // Check if it exists using the same bytes
      const result = userUxtosService.hasEncryptedOutput(bytes);
      
      expect(result).toBe(true);
    });

    it('should return false for non-existing output', () => {
      const output = '0123456789abcdef0123456789abcdef';
      const nonExistingOutput = 'fedcba9876543210fedcba9876543210';
      
      // Add one output
      userUxtosService.addEncryptedOutput(output);
      
      // Check for a different one
      const result = userUxtosService.hasEncryptedOutput(nonExistingOutput);
      
      expect(result).toBe(false);
    });

    it('should throw error if not initialized', () => {
      // Reset the service initialization flag
      (userUxtosService as any).initialized = false;
      
      expect(() => userUxtosService.hasEncryptedOutput('test')).toThrow(
        'UserUxtosService not initialized'
      );
    });
  });

  describe('getAllEncryptedOutputs', () => {
    it('should return all encrypted outputs', () => {
      const outputs = [
        '0123456789abcdef0123456789abcdef',
        'fedcba9876543210fedcba9876543210',
        'aabbccddeeff00112233445566778899'
      ];
      
      // Add multiple outputs
      outputs.forEach(output => userUxtosService.addEncryptedOutput(output));
      
      // Get all outputs
      const result = userUxtosService.getAllEncryptedOutputs();
      
      expect(result).toHaveLength(outputs.length);
      outputs.forEach(output => expect(result).toContain(output));
    });

    it('should return empty array when no outputs exist', () => {
      const result = userUxtosService.getAllEncryptedOutputs();
      
      expect(result).toEqual([]);
    });

    it('should throw error if not initialized', () => {
      // Reset the service initialization flag
      (userUxtosService as any).initialized = false;
      
      expect(() => userUxtosService.getAllEncryptedOutputs()).toThrow(
        'UserUxtosService not initialized'
      );
    });
  });

  describe('getEncryptedOutputCount', () => {
    it('should return the correct count of encrypted outputs', () => {
      const outputs = [
        '0123456789abcdef0123456789abcdef',
        'fedcba9876543210fedcba9876543210',
        'aabbccddeeff00112233445566778899'
      ];
      
      // Add multiple outputs
      outputs.forEach(output => userUxtosService.addEncryptedOutput(output));
      
      // Get count
      const count = userUxtosService.getEncryptedOutputCount();
      
      expect(count).toBe(outputs.length);
    });

    it('should return 0 when no outputs exist', () => {
      const count = userUxtosService.getEncryptedOutputCount();
      
      expect(count).toBe(0);
    });

    it('should throw error if not initialized', () => {
      // Reset the service initialization flag
      (userUxtosService as any).initialized = false;
      
      expect(() => userUxtosService.getEncryptedOutputCount()).toThrow(
        'UserUxtosService not initialized'
      );
    });
  });
}); 