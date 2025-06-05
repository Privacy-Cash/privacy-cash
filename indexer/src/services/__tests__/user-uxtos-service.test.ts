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

  describe('ordering behavior', () => {
    it('should maintain insertion order in getAllEncryptedOutputs', () => {
      const outputs = [
        'first0123456789abcdef0123456789ab',
        'second456789abcdef0123456789abcd',
        'third89abcdef0123456789abcdef01',
        'fourth3456789abcdef0123456789ab',
        'fifth56789abcdef0123456789abcde',
        'sixth789abcdef0123456789abcdef0',
        'seventh9abcdef0123456789abcdef01',
        'eighthbcdef0123456789abcdef0123',
        'ninthcdef0123456789abcdef01234',
        'tenthdef0123456789abcdef012345',
        'eleventhef0123456789abcdef01234',
        'twelfthf0123456789abcdef012345',
        'thirteenth0123456789abcdef0123',
        'fourteenth123456789abcdef01234',
        'fifteenth23456789abcdef012345',
        'sixteenth3456789abcdef0123456',
        'seventeenth456789abcdef01234'
      ];
      
      // Add outputs in specific order
      outputs.forEach(output => userUxtosService.addEncryptedOutput(output));
      
      // Get all outputs
      const result = userUxtosService.getAllEncryptedOutputs();
      
      // Verify they're returned in the same order
      expect(result).toEqual(outputs);
    });

    it('should maintain insertion order in getEncryptedOutputsRange', () => {
      const outputs = [
        'alpha123456789abcdef0123456789ab',
        'beta456789abcdef0123456789abcd',
        'gamma89abcdef0123456789abcdef01',
        'delta3456789abcdef0123456789ab',
        'epsilon56789abcdef0123456789abc',
        'zeta789abcdef0123456789abcdef0',
        'eta9abcdef0123456789abcdef012',
        'thetabcdef0123456789abcdef0123',
        'iotacdef0123456789abcdef01234',
        'kappadef0123456789abcdef012345',
        'lambdaef0123456789abcdef01234',
        'muf0123456789abcdef012345678',
        'nu0123456789abcdef0123456789',
        'xi123456789abcdef0123456789a',
        'omicron23456789abcdef01234567',
        'pi3456789abcdef012345678901',
        'rho456789abcdef0123456789012',
        'sigma56789abcdef01234567890',
        'tau6789abcdef012345678901ab'
      ];
      
      // Add outputs in specific order
      outputs.forEach(output => userUxtosService.addEncryptedOutput(output));
      
      // Get range from index 5 to 12
      const result = userUxtosService.getEncryptedOutputsRange(5, 12);
      
      // Verify the range maintains order
      expect(result.encrypted_outputs).toEqual([
        'zeta789abcdef0123456789abcdef0',
        'eta9abcdef0123456789abcdef012',
        'thetabcdef0123456789abcdef0123',
        'iotacdef0123456789abcdef01234',
        'kappadef0123456789abcdef012345',
        'lambdaef0123456789abcdef01234',
        'muf0123456789abcdef012345678',
        'nu0123456789abcdef0123456789'
      ]);
      expect(result.start).toBe(5);
      expect(result.end).toBe(12);
      expect(result.total).toBe(19);
      expect(result.hasMore).toBe(true);
    });

    it('should handle mixed string and Uint8Array inputs while maintaining order', () => {
      const mixedInputs = [
        'string01_123456789abcdef012345',
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        'string02_456789abcdef01234567',
        new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18]),
        'string03_789abcdef0123456789a',
        new Uint8Array([19, 20, 21, 22, 23, 24, 25, 26]),
        'string04_abcdef0123456789abc',
        new Uint8Array([27, 28, 29, 30, 31, 32, 33, 34]),
        'string05_bcdef0123456789abcd',
        new Uint8Array([35, 36, 37, 38, 39, 40, 41, 42]),
        'string06_cdef0123456789abcde',
        new Uint8Array([43, 44, 45, 46, 47, 48, 49, 50]),
        'string07_def0123456789abcdef',
        new Uint8Array([51, 52, 53, 54, 55, 56, 57, 58]),
        'string08_ef0123456789abcdef0',
        new Uint8Array([59, 60, 61, 62, 63, 64, 65, 66]),
        'string09_f0123456789abcdef01'
      ];
      
      // Add in mixed order
      mixedInputs.forEach(input => userUxtosService.addEncryptedOutput(input));
      
      // Get all outputs
      const result = userUxtosService.getAllEncryptedOutputs();
      
      // Build expected order with Uint8Arrays converted to hex
      const expectedOrder = mixedInputs.map(input => 
        input instanceof Uint8Array 
          ? Buffer.from(input).toString('hex')
          : input
      );
      
      expect(result).toEqual(expectedOrder);
      expect(result).toHaveLength(17);
    });

    it('should maintain insertion order even with duplicate entries', () => {
      const outputsWithDuplicates = [
        'first0123456789abcdef0123456789ab',
        'second456789abcdef0123456789abcd',
        'third89abcdef0123456789abcdef01',
        'second456789abcdef0123456789abcd', // duplicate of index 1
        'fourth3456789abcdef0123456789ab',
        'first0123456789abcdef0123456789ab', // duplicate of index 0
        'fifth56789abcdef0123456789abcde',
        'sixth789abcdef0123456789abcdef0',
        'third89abcdef0123456789abcdef01', // duplicate of index 2
        'seventh9abcdef0123456789abcdef01',
        'eighth8bcdef0123456789abcdef012',
        'fourth3456789abcdef0123456789ab', // duplicate of index 4
        'ninth9cdef0123456789abcdef0123',
        'tenth0def0123456789abcdef01234',
        'fifth56789abcdef0123456789abcde', // duplicate of index 6
        'eleventh1ef0123456789abcdef012',
        'twelfth2f0123456789abcdef0123',
        'sixth789abcdef0123456789abcdef0', // duplicate of index 7
        'thirteenth30123456789abcdef012'
      ];
      
      // Expected unique outputs in order of first occurrence
      const expectedUniqueOutputs = [
        'first0123456789abcdef0123456789ab',    // first occurrence at index 0
        'second456789abcdef0123456789abcd',     // first occurrence at index 1
        'third89abcdef0123456789abcdef01',      // first occurrence at index 2
        'fourth3456789abcdef0123456789ab',      // first occurrence at index 4
        'fifth56789abcdef0123456789abcde',      // first occurrence at index 6
        'sixth789abcdef0123456789abcdef0',      // first occurrence at index 7
        'seventh9abcdef0123456789abcdef01',     // first occurrence at index 9
        'eighth8bcdef0123456789abcdef012',      // first occurrence at index 10
        'ninth9cdef0123456789abcdef0123',       // first occurrence at index 12
        'tenth0def0123456789abcdef01234',       // first occurrence at index 13
        'eleventh1ef0123456789abcdef012',       // first occurrence at index 15
        'twelfth2f0123456789abcdef0123',        // first occurrence at index 16
        'thirteenth30123456789abcdef012'        // first occurrence at index 18
      ];
      
      // Track which additions were successful vs duplicates
      const addResults: boolean[] = [];
      
      // Add outputs in order, tracking results
      outputsWithDuplicates.forEach(output => {
        const added = userUxtosService.addEncryptedOutput(output);
        addResults.push(added);
      });
      
      // Verify that duplicates were rejected appropriately
      const expectedResults = [
        true,  // first - added
        true,  // second - added
        true,  // third - added
        false, // second (duplicate) - rejected
        true,  // fourth - added
        false, // first (duplicate) - rejected
        true,  // fifth - added
        true,  // sixth - added
        false, // third (duplicate) - rejected
        true,  // seventh - added
        true,  // eighth - added
        false, // fourth (duplicate) - rejected
        true,  // ninth - added
        true,  // tenth - added  
        false, // fifth (duplicate) - rejected
        true,  // eleventh - added
        true,  // twelfth - added
        false, // sixth (duplicate) - rejected
        true   // thirteenth - added
      ];
      
      expect(addResults).toEqual(expectedResults);
      
      // Get all outputs and verify order
      const result = userUxtosService.getAllEncryptedOutputs();
      
      // Should maintain order of first occurrence of each unique item
      expect(result).toEqual(expectedUniqueOutputs);
      expect(result).toHaveLength(expectedUniqueOutputs.length);
      
      // Verify count matches unique items
      expect(userUxtosService.getEncryptedOutputCount()).toBe(expectedUniqueOutputs.length);
    });
  });
}); 