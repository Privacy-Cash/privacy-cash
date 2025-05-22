import { LightWasm } from '@lightprotocol/hasher.rs';
import { MerkleTree } from '../merkle_tree';

// Mock LightWasm
jest.mock('@lightprotocol/hasher.rs', () => {
  const mockLightWasm = {
    poseidonHashString: jest.fn((inputs) => {
      // Simple mock hash function
      return `hash_${inputs.join('_')}`;
    })
  };

  return {
    LightWasm: jest.fn().mockImplementation(() => mockLightWasm)
  };
});

describe('MerkleTree', () => {
  let lightWasm: any;
  let merkleTree: MerkleTree;
  const levels = 3;
  const initialElements = ['element0', 'element1', 'element2'];

  beforeEach(() => {
    // Get an instance of our mocked LightWasm
    const { LightWasm } = require('@lightprotocol/hasher.rs');
    lightWasm = new LightWasm();
    merkleTree = new MerkleTree(levels, lightWasm, initialElements);
  });

  describe('update', () => {
    it('should update an existing element and recalculate hashes', () => {
      // Save original root
      const originalRoot = merkleTree.root();
      
      // Update element at index 1
      const newElement = 'updatedElement';
      merkleTree.update(1, newElement);
      
      // Check if element was updated
      expect(merkleTree.elements()[1]).toBe(newElement);
      
      // Check if root changed
      const newRoot = merkleTree.root();
      expect(newRoot).not.toBe(originalRoot);
    });

    it('should throw an error for index out of bounds (negative)', () => {
      expect(() => {
        merkleTree.update(-1, 'element');
      }).toThrow('Insert index out of bounds');
    });

    it('should throw an error for index out of bounds (> array length)', () => {
      // Create a tree with exactly the same number of elements as our test array
      const exactTree = new MerkleTree(3, lightWasm, [...initialElements]);
      
      expect(() => {
        exactTree.update(initialElements.length + 1, 'element');
      }).toThrow('Insert index out of bounds');
    });

    it('should throw an error for index out of bounds (>= capacity)', () => {
      const smallTree = new MerkleTree(2, lightWasm, ['element0']);
      // Capacity is 2^2 = 4
      expect(() => {
        smallTree.update(4, 'element');
      }).toThrow('Insert index out of bounds');
    });

    it('should throw an error for NaN index', () => {
      expect(() => {
        merkleTree.update(NaN, 'element');
      }).toThrow('Insert index out of bounds');
    });

    it('should correctly update path to the root', () => {
      // Update element at index 2
      merkleTree.update(2, 'newElement2');
      
      // Get the elements
      const elements = merkleTree.elements();
      expect(elements[2]).toBe('newElement2');
      
      // Check that hashes were recalculated up to the root
      // Here we're relying on our mock implementation of poseidonHashString
      const root = merkleTree.root();
      // We don't test the exact hash value since we're mocking it, but we verify it's a string
      expect(typeof root).toBe('string');
    });

    it('should allow updating the last existing element', () => {
      // Update the last element
      const lastIndex = initialElements.length - 1;
      merkleTree.update(lastIndex, 'lastUpdated');
      
      // Check if element was updated
      expect(merkleTree.elements()[lastIndex]).toBe('lastUpdated');
    });

    it('should allow updating at exactly the array length (inserting new element)', () => {
      const exactTree = new MerkleTree(3, lightWasm, [...initialElements]);
      const initialLength = exactTree.elements().length;
      
      // Should not throw
      exactTree.update(initialLength, 'newElement');
      
      // Check that the element was added
      const elements = exactTree.elements();
      expect(elements.length).toBe(initialLength + 1);
      expect(elements[initialLength]).toBe('newElement');
    });

    it('should throw an error for index exceeding array length', () => {
      // Test the boundary condition fix for update method
      const tree = new MerkleTree(3, lightWasm, ['elem0', 'elem1']);
      
      // This should throw (exceeds current length)
      expect(() => {
        tree.update(3, 'invalidElement');
      }).toThrow('Insert index out of bounds');
      
      // This should be fine (at current length)
      expect(() => {
        tree.update(2, 'validElement');
      }).not.toThrow();
    });

    it('should handle updates in non-sequential order', () => {
      // Create a tree with 4 elements
      const tree = new MerkleTree(3, lightWasm, ['initial0', 'initial1', 'initial2', 'initial3']);
      
      // Update indices in non-sequential order
      tree.update(0, 'updated0');
      expect(tree.elements()[0]).toBe('updated0');
      
      tree.update(3, 'updated3');
      expect(tree.elements()[3]).toBe('updated3');
      
      tree.update(1, 'updated1');
      expect(tree.elements()[1]).toBe('updated1');
      
      tree.update(2, 'updated2');
      expect(tree.elements()[2]).toBe('updated2');
      
      // Check that all elements are now as expected
      expect(tree.elements()).toEqual(['updated0', 'updated1', 'updated2', 'updated3']);
      
      // The root should be consistent
      const root = tree.root();
      expect(typeof root).toBe('string');
    });
    
    it('should allow sequential insertion using update', () => {
      // Start with an empty tree
      const tree = new MerkleTree(3, lightWasm, []);
      
      // Insert sequentially using update
      tree.update(0, 'element0');
      expect(tree.elements().length).toBe(1);
      expect(tree.elements()[0]).toBe('element0');
      
      tree.update(1, 'element1');
      expect(tree.elements().length).toBe(2);
      expect(tree.elements()[1]).toBe('element1');
      
      tree.update(2, 'element2');
      expect(tree.elements().length).toBe(3);
      expect(tree.elements()[2]).toBe('element2');
      
      tree.update(3, 'element3');
      expect(tree.elements().length).toBe(4);
      expect(tree.elements()[3]).toBe('element3');
      
      // Check that all elements are as expected
      expect(tree.elements()).toEqual(['element0', 'element1', 'element2', 'element3']);
    });
    
    it('should not allow true non-sequential insertion', () => {
      // Start with an empty tree
      const tree = new MerkleTree(3, lightWasm, []);
      
      // Insert at index 0
      tree.update(0, 'element0');
      
      // Trying to insert at index 2 (skipping 1) should throw
      expect(() => {
        tree.update(2, 'element2');
      }).toThrow('Insert index out of bounds');
      
      // Similarly for index 3
      expect(() => {
        tree.update(3, 'element3');
      }).toThrow('Insert index out of bounds');
    });
    
    it('should produce the same root hash regardless of update order', () => {
      // Create tree with sequential updates: 0, 1, 2, 3
      const sequentialTree = new MerkleTree(3, lightWasm, []);
      sequentialTree.update(0, 'element0');
      sequentialTree.update(1, 'element1');
      sequentialTree.update(2, 'element2');
      sequentialTree.update(3, 'element3');
      const sequentialRoot = sequentialTree.root();
      
      // Create a tree with existing elements
      const nonSequentialTree = new MerkleTree(3, lightWasm, [
        'element0', 'element1', 'element2', 'element3'
      ]);
      
      // Update in non-sequential order: 0, 3, 1, 2
      nonSequentialTree.update(0, 'element0'); // Same value, just to trigger update
      nonSequentialTree.update(3, 'element3');
      nonSequentialTree.update(1, 'element1');
      nonSequentialTree.update(2, 'element2');
      const nonSequentialRoot = nonSequentialTree.root();
      
      // Both roots should be identical
      expect(nonSequentialRoot).toBe(sequentialRoot);
      
      // Also verify with another tree updated in a different order: 2, 0, 3, 1
      const anotherTree = new MerkleTree(3, lightWasm, [
        'element0', 'element1', 'element2', 'element3'
      ]);
      anotherTree.update(2, 'element2');
      anotherTree.update(0, 'element0');
      anotherTree.update(3, 'element3');
      anotherTree.update(1, 'element1');
      
      expect(anotherTree.root()).toBe(sequentialRoot);
    });

    it('should have the same final root hash with different update orders and different values', () => {
      // Create initial trees with placeholder values
      const tree1 = new MerkleTree(3, lightWasm, ['initial0', 'initial1', 'initial2', 'initial3']);
      const tree2 = new MerkleTree(3, lightWasm, ['initial0', 'initial1', 'initial2', 'initial3']);
      
      // Tree 1: Update in sequential order (0, 1, 2, 3)
      tree1.update(0, 'final0');
      tree1.update(1, 'final1');
      tree1.update(2, 'final2');
      tree1.update(3, 'final3');
      
      // Tree 2: Update in non-sequential order (0, 3, 1, 2)
      tree2.update(0, 'final0');
      tree2.update(3, 'final3');
      tree2.update(1, 'final1');
      tree2.update(2, 'final2');
      
      // Both trees should have the same root
      expect(tree2.root()).toBe(tree1.root());
      
      // Additional validation with a third tree, different update order (3, 2, 1, 0)
      const tree3 = new MerkleTree(3, lightWasm, ['initial0', 'initial1', 'initial2', 'initial3']);
      tree3.update(3, 'final3');
      tree3.update(2, 'final2');
      tree3.update(1, 'final1');
      tree3.update(0, 'final0');
      
      expect(tree3.root()).toBe(tree1.root());
      
      // Verify the contents are the same regardless of update order
      expect(tree1.elements()).toEqual(['final0', 'final1', 'final2', 'final3']);
      expect(tree2.elements()).toEqual(['final0', 'final1', 'final2', 'final3']);
      expect(tree3.elements()).toEqual(['final0', 'final1', 'final2', 'final3']);
    });
  });
}); 