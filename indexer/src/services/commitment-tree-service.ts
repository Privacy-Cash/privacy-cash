import { WasmFactory } from '@lightprotocol/hasher.rs';
import { MerkleTree } from '../lib/merkle_tree';
import { logger } from '../utils/logger';

// Default tree height for the Merkle tree
const DEFAULT_TREE_HEIGHT = 26;

class CommitmentTreeService {
  private tree: MerkleTree | null = null;
  private initialized = false;
  private commitmentMap: Map<string, number> = new Map(); // Maps commitment hash to its index in the tree
  private lightWasm: any = null;

  /**
   * Initialize the commitment tree
   */
  async initialize(): Promise<void> {
    if (this.initialized && this.tree) {
      logger.info('Commitment tree already initialized, skipping initialization');
      return;
    }

    try {
      logger.info('Initializing commitment tree service...');
      
      // Initialize the light protocol hasher
      this.lightWasm = await WasmFactory.getInstance();
      
      // Create a new tree
      this.tree = new MerkleTree(DEFAULT_TREE_HEIGHT, this.lightWasm);
      logger.info('Created new Merkle tree');
      
      this.initialized = true;
      logger.info(`Merkle tree initialized with root: ${this.getRoot()}`);
    } catch (error) {
      logger.error('Error initializing commitment tree:' + String(error));
      throw error;
    }
  }

  /**
   * Add a new commitment to the Merkle tree
   * 
   * !!!! 
   * Since this method is synchronous and node.js is single threaded, we don't need to worry about race conditions.
   * !!!!
   * @param commitmentHash The commitment hash as a hex string
   * @param index The index of the commitment (used for verification)
   * @returns true if the commitment was added, false if it already exists
   */
  addCommitment(commitmentHash: string, index: bigint | number): boolean {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }

    // Check if commitment already exists
    if (this.commitmentMap.has(commitmentHash)) {
      logger.info(`Commitment ${commitmentHash} already exists at index ${this.commitmentMap.get(commitmentHash)}`);
      return false;
    }

    try {
      // Convert index to number if it's a bigint
      const numericIndex = typeof index === 'bigint' ? Number(index) : index;
      
      // Convert hex commitment to decimal string if it's not in decimal format already
      // The hasher library expects decimal strings
      let commitmentDecimal = commitmentHash;
      if (commitmentHash.startsWith('0x')) {
        commitmentDecimal = BigInt(commitmentHash).toString();
      } else if (/^[0-9a-f]+$/i.test(commitmentHash)) {
        // If it looks like a hex string without 0x prefix
        commitmentDecimal = BigInt('0x' + commitmentHash).toString();
      }
      
      logger.info(`Processing commitment ${commitmentHash} at index ${numericIndex}, decimal value: ${commitmentDecimal}`);
      
      // Get current tree size
      const currentSize = this.tree.elements().length;
      
      // Handle based on index
      if (numericIndex === currentSize) {
        // Normal case: add as next element
        this.tree.insert(commitmentDecimal);
        this.commitmentMap.set(commitmentHash, numericIndex);
        logger.info(`Added commitment ${commitmentHash} at index ${numericIndex}`);
        logger.info(`New Merkle tree root: ${this.getRoot()}`);
        return true;
      } else if (numericIndex < currentSize) {
        // Commitment belongs at an index that already has an element
        // This shouldn't happen, but we handle it by updating the element
        logger.warn(`Updating commitment at index ${numericIndex}, this is unusual`);
        this.tree.update(numericIndex, commitmentDecimal);
        this.commitmentMap.set(commitmentHash, numericIndex);
        logger.info(`Updated commitment ${commitmentHash} at index ${numericIndex}`);
        logger.info(`New Merkle tree root: ${this.getRoot()}`);
        return true;
      } else {
        // Commitment belongs at a future index
        logger.info(`Cannot add commitment ${commitmentHash} at future index ${numericIndex}, current size is ${currentSize}`);
        return false;
      }
    } catch (error) {
      logger.error(`Error adding commitment ${commitmentHash} at index ${index}:` + String(error));
      return false;
    }
  }

  /**
   * Bulk add multiple commitments to the tree
   * @param commitments Array of {hash, index} objects
   * @returns The number of commitments successfully added
   */
  addCommitments(commitments: Array<{hash: string, index: bigint | number}>): number {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }

    let addedCount = 0;
    
    // Sort commitments by index to ensure they're added in the correct order
    const sortedCommitments = [...commitments].sort((a, b) => {
      const aIdx = typeof a.index === 'bigint' ? Number(a.index) : a.index;
      const bIdx = typeof b.index === 'bigint' ? Number(b.index) : b.index;
      return aIdx - bIdx;
    });
    
    for (const { hash, index } of sortedCommitments) {
      if (this.addCommitment(hash, index)) {
        addedCount++;
      }
    }
    
    return addedCount;
  }

  /**
   * Get the current Merkle tree root
   * @returns The Merkle tree root as a string
   */
  getRoot(): string {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }
    
    return this.tree.root();
  }

  /**
   * Get a Merkle proof for a commitment at a specific index
   * @param index The index of the commitment
   * @returns The Merkle proof
   */
  getMerkleProof(index: number): {pathElements: string[], pathIndices: number[]} {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }
    
    if (index < 0 || index >= this.tree.elements().length) {
      throw new Error(`Index ${index} is out of bounds`);
    }
    
    return this.tree.path(index);
  }

  /**
   * Get all commitments in the tree
   * @returns Array of commitment hashes
   */
  getAllCommitments(): string[] {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }
    
    return this.tree.elements();
  }

  /**
   * Get the current next index (number of elements in the tree)
   * @returns The next index where a new commitment would be inserted
   */
  getNextIndex(): number {
    if (!this.initialized || !this.tree) {
      throw new Error('Commitment tree service not initialized');
    }
    
    return this.tree.elements().length;
  }
}

// Create and export a singleton instance
export const commitmentTreeService = new CommitmentTreeService(); 