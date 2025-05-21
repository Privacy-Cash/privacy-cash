import { WasmFactory } from '@lightprotocol/hasher.rs';
import { MerkleTree } from '../lib/merkle_tree';

// Default tree height for the Merkle tree
const DEFAULT_TREE_HEIGHT = 20;

class CommitmentTreeService {
  private tree: MerkleTree | null = null;
  private initialized = false;
  private commitmentMap: Map<string, number> = new Map(); // Maps commitment hash to its index in the tree
  private pendingCommitments: Array<{hash: string, index: number, decimalValue: string}> = []; // Store commitments with future indices

  /**
   * Initialize the commitment tree
   */
  async initialize(): Promise<void> {
    try {
      // Initialize the light protocol hasher
      const lightWasm = await WasmFactory.getInstance();
      
      // Create a new tree
      this.tree = new MerkleTree(DEFAULT_TREE_HEIGHT, lightWasm);
      console.log('Created new Merkle tree');
      
      this.initialized = true;
      console.log(`Merkle tree initialized with root: ${this.getRoot()}`);
    } catch (error) {
      console.error('Error initializing commitment tree:', error);
      throw error;
    }
  }

  /**
   * Process any pending commitments that can now be added
   */
  private processPendingCommitments(): void {
    if (!this.initialized || !this.tree) {
      return;
    }

    // Current size of the tree
    const currentSize = this.tree.elements().length;
    
    // Sort pending commitments by index
    this.pendingCommitments.sort((a, b) => a.index - b.index);
    
    // Process commitments that can now be added
    let i = 0;
    while (i < this.pendingCommitments.length) {
      const pending = this.pendingCommitments[i];
      
      // If this commitment is at the current size or has a gap, we can't add it yet
      if (pending.index > currentSize) {
        break;
      }
      
      // Add the commitment directly
      if (pending.index === currentSize) {
        this.tree.insert(pending.decimalValue);
        this.commitmentMap.set(pending.hash, pending.index);
        console.log(`Added pending commitment ${pending.hash} at index ${pending.index}`);
      } else if (pending.index < currentSize) {
        // Update existing element
        this.tree.update(pending.index, pending.decimalValue);
        this.commitmentMap.set(pending.hash, pending.index);
        console.log(`Updated existing element with pending commitment ${pending.hash} at index ${pending.index}`);
      }
      
      // Remove this commitment from the pending list
      this.pendingCommitments.splice(i, 1);
      
      // Don't increment i since we've removed an element
    }
    
    if (this.pendingCommitments.length > 0) {
      console.log(`${this.pendingCommitments.length} commitments still pending`);
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
      console.log(`Commitment ${commitmentHash} already exists at index ${this.commitmentMap.get(commitmentHash)}`);
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
      
      console.log(`Processing commitment ${commitmentHash} at index ${numericIndex}, decimal value: ${commitmentDecimal}`);
      
      // Get current tree size
      const currentSize = this.tree.elements().length;
      
      // Handle based on index
      if (numericIndex === currentSize) {
        // Normal case: add as next element
        this.tree.insert(commitmentDecimal);
        this.commitmentMap.set(commitmentHash, numericIndex);
        console.log(`Added commitment ${commitmentHash} at index ${numericIndex}`);
        
        // Process any pending commitments that might now be valid
        this.processPendingCommitments();
        
        console.log(`New Merkle tree root: ${this.getRoot()}`);
        return true;
      } else if (numericIndex < currentSize) {
        // Commitment belongs at an index that already has an element
        // This shouldn't happen, but we handle it by updating the element
        console.warn(`Updating commitment at index ${numericIndex}, this is unusual`);
        this.tree.update(numericIndex, commitmentDecimal);
        this.commitmentMap.set(commitmentHash, numericIndex);
        console.log(`Updated commitment ${commitmentHash} at index ${numericIndex}`);
        console.log(`New Merkle tree root: ${this.getRoot()}`);
        return true;
      } else {
        // Commitment belongs at a future index, add to pending list
        console.log(`Adding commitment ${commitmentHash} to pending list (index ${numericIndex}, current size ${currentSize})`);
        this.pendingCommitments.push({
          hash: commitmentHash,
          index: numericIndex,
          decimalValue: commitmentDecimal
        });
        return true;
      }
    } catch (error) {
      console.error(`Error adding commitment ${commitmentHash} at index ${index}:`, error);
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
   * Get number of pending commitments
   * @returns Number of commitments waiting to be added
   */
  getPendingCount(): number {
    return this.pendingCommitments.length;
  }
}

// Create and export a singleton instance
export const commitmentTreeService = new CommitmentTreeService(); 