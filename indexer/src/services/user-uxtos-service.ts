/**
 * UserUxtosService maintains a hashset of encrypted UXTOs
 */
class UserUxtosService {
  private initialized = false;
  private encryptedOutputs: Set<string> = new Set(); // Hashset of encrypted outputs

  /**
   * Initialize the user UXTOs service
   */
  initialize(): void {
    if (this.initialized) {
      console.log('UserUxtosService already initialized, skipping initialization');
      return;
    }

    try {
      console.log('Initializing UserUxtosService...');
      this.initialized = true;
      console.log(`UserUxtosService initialized with ${this.encryptedOutputs.size} encrypted outputs`);
    } catch (error) {
      console.error('Error initializing UserUxtosService:', error);
      throw error;
    }
  }

  /**
   * Add an encrypted output to the hashset
   * @param encryptedOutput The encrypted output as a hex or base64 string
   * @returns true if the encrypted output was added, false if it already exists
   */
  addEncryptedOutput(encryptedOutput: Uint8Array | string): boolean {
    if (!this.initialized) {
      throw new Error('UserUxtosService not initialized');
    }

    // Convert Uint8Array to hex string if needed
    const outputString = encryptedOutput instanceof Uint8Array 
      ? Buffer.from(encryptedOutput).toString('hex')
      : encryptedOutput;

    // Check if encrypted output already exists
    if (this.encryptedOutputs.has(outputString)) {
      console.log(`Encrypted output ${outputString.substring(0, 16)}... already exists`);
      return false;
    }

    // Add to the set
    this.encryptedOutputs.add(outputString);
    console.log(`Added encrypted output ${outputString.substring(0, 16)}...`);
    return true;
  }

  /**
   * Check if an encrypted output exists in the hashset
   * @param encryptedOutput The encrypted output as a hex or base64 string
   * @returns true if the encrypted output exists, false otherwise
   */
  hasEncryptedOutput(encryptedOutput: Uint8Array | string): boolean {
    if (!this.initialized) {
      throw new Error('UserUxtosService not initialized');
    }

    // Convert Uint8Array to hex string if needed
    const outputString = encryptedOutput instanceof Uint8Array 
      ? Buffer.from(encryptedOutput).toString('hex')
      : encryptedOutput;

    return this.encryptedOutputs.has(outputString);
  }

  /**
   * Get all encrypted outputs in the hashset
   * @returns Array of encrypted outputs as strings
   */
  getAllEncryptedOutputs(): string[] {
    if (!this.initialized) {
      throw new Error('UserUxtosService not initialized');
    }

    return Array.from(this.encryptedOutputs);
  }

  /**
   * Get the number of encrypted outputs in the hashset
   * @returns Number of encrypted outputs
   */
  getEncryptedOutputCount(): number {
    if (!this.initialized) {
      throw new Error('UserUxtosService not initialized');
    }

    return this.encryptedOutputs.size;
  }
}

// Create and export a singleton instance
export const userUxtosService = new UserUxtosService(); 