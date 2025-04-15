#[cfg(test)]
mod tests {
    use light_hasher::{Poseidon, Hasher};
    
    // Import from the properly structured module
    use zkcash::lib::sparse_merkle_tree::SparseMerkleTreeWithHistory;
    
    #[test]
    fn test_new_empty() {
        // Test initialization of an empty tree
        let tree: SparseMerkleTreeWithHistory<Poseidon, 10> = SparseMerkleTreeWithHistory::new_empty();
        
        // Verify initial state
        assert_eq!(tree.get_next_index(), 0);
        assert_eq!(tree.get_height(), 10);
        
        // Root of empty tree should match the HEIGHT-th zero byte
        let zero_bytes = Poseidon::zero_bytes();
        assert_eq!(tree.root(), zero_bytes[10]);
        
        // All subtrees should be zero bytes
        let subtrees = tree.get_subtrees();
        for i in 0..10 {
            assert_eq!(subtrees[i], zero_bytes[i]);
        }
    }
    
    #[test]
    fn test_append_single_leaf() {
        // Initialize empty tree
        let mut tree: SparseMerkleTreeWithHistory<Poseidon, 5> = SparseMerkleTreeWithHistory::new_empty();
        
        // Create a test leaf
        let mut leaf = [0u8; 32];
        leaf[0] = 1; // Simple non-zero value
        
        // Append the leaf
        let proof = tree.append(leaf);
        
        // Verify index was incremented
        assert_eq!(tree.get_next_index(), 1);
        
        // Verify proof contains expected values (zeros for empty tree)
        let zero_bytes = Poseidon::zero_bytes();
        for i in 0..5 {
            assert_eq!(proof[i], zero_bytes[i]);
        }
        
        // Root should no longer be the default zero value
        assert_ne!(tree.root(), zero_bytes[5]);
    }
    
    #[test]
    fn test_append_multiple_leaves() {
        // Initialize empty tree with height 5 to avoid overflow
        let mut tree: SparseMerkleTreeWithHistory<Poseidon, 5> = SparseMerkleTreeWithHistory::new_empty();
        
        // Create and append 8 leaves (not enough to fill a tree of height 5)
        let mut prev_root = tree.root();
        for i in 0..8 {
            let mut leaf = [0u8; 32];
            // Make leaf non-zero even when i=0 to ensure the root changes
            leaf[0] = 1;
            
            tree.append(leaf);
            
            // Root should change with each append
             assert_ne!(tree.root(), prev_root);
            prev_root = tree.root();
            
            // Index should be incremented
            assert_eq!(tree.get_next_index(), i + 1);
        }
    }
    
    #[test]
    fn test_deterministic_output() {
        // Initialize two identical empty trees
        let mut tree1: SparseMerkleTreeWithHistory<Poseidon, 3> = SparseMerkleTreeWithHistory::new_empty();
        let mut tree2: SparseMerkleTreeWithHistory<Poseidon, 3> = SparseMerkleTreeWithHistory::new_empty();
        
        // Append the same leaves to both trees
        for i in 0..4 {
            let mut leaf = [0u8; 32];
            leaf[31] = i as u8;
            
            tree1.append(leaf);
            tree2.append(leaf);
            
            // Both trees should have the same root after identical operations
            assert_eq!(tree1.root(), tree2.root());
            assert_eq!(tree1.get_subtrees(), tree2.get_subtrees());
        }
    }
    
    #[test]
    fn test_comparison_with_right_root_hash() {
        // Setup
        let mut tree = SparseMerkleTreeWithHistory::<Poseidon, 2>::new_empty();
        
        // Add some known leaves and verify expected behavior
        let test_leaves = [
            // Leaf data (all have at least one non-zero byte)
            [1u8; 32],
            [2u8; 32]
        ];

        // First leaf append
        tree.append(test_leaves[0]);
        let root_after_first = tree.root();
        
        // Root should change after first append
        let initial_root = Poseidon::zero_bytes()[2];
        assert_ne!(root_after_first, initial_root, "Root should change after first append");
        
        // Second leaf append
        tree.append(test_leaves[1]);
        let root_after_second = tree.root();
        
        // Root should change after second append
        assert_ne!(root_after_second, root_after_first, "Root should change after second append");
        
        // Verify final index
        assert_eq!(tree.get_next_index(), 2);
        
        // Get the subtrees
        let subtrees = tree.get_subtrees();
        
        let zero_bytes = Poseidon::zero_bytes();
        let expected_root = Poseidon::hashv(&[&subtrees[1], &zero_bytes[1]]).unwrap();
        
        // Verify the root hash matches our calculated expected value
        assert_eq!(root_after_second, expected_root,
            "Root hash doesn't match expected calculation");
    }

    #[test]
    fn test_root_history_initial_state() {
        // Initialize empty tree with height 20 
        let tree: SparseMerkleTreeWithHistory<Poseidon, 20> = SparseMerkleTreeWithHistory::new_empty();

        // Check that the root history is initialized correctly
        let root_history = tree.get_root_history();
        assert_eq!(root_history[0], Poseidon::zero_bytes()[20]);
        assert_eq!(tree.get_current_root_index(), 0);
    }

    #[test]
    fn test_root_history() {
        // Initialize empty tree with height 3
        let mut tree: SparseMerkleTreeWithHistory<Poseidon, 3> = SparseMerkleTreeWithHistory::new_empty();
        
        // Initial state check
        assert_eq!(tree.get_current_root_index(), 0);
        let initial_root = tree.root();
        
        // Create and append 5 leaves
        let mut expected_roots = Vec::new();
        expected_roots.push(initial_root);
        
        for i in 0..5 {
            let mut leaf = [0u8; 32];
            leaf[0] = (i + 1) as u8; // Make each leaf unique
            
            tree.append(leaf);
            expected_roots.push(tree.root());
        }
        
        // Check that the root history contains the expected roots
        let root_history = tree.get_root_history();
        
        // The root history should have roots at indices 0-4 
        // (since current_root_index = 5 after 5 appends)
        for i in 0..6 {
            assert_eq!(root_history[i], expected_roots[i], 
                "Root history at index {} doesn't match expected root", i);
        }
        
        // And the current index should be 5
        assert_eq!(tree.get_current_root_index(), 5);
    }

    #[test]
    fn test_root_history_circular_buffer() {
       // Initialize empty tree with height 3
       let mut tree: SparseMerkleTreeWithHistory<Poseidon, 3> = SparseMerkleTreeWithHistory::new_empty();
        
       // Initial state check
       assert_eq!(tree.get_current_root_index(), 0);
       let initial_root = tree.root();
       
       // Store all roots as we append leaves
       let mut all_roots = Vec::new();
       all_roots.push(initial_root); // Initial root before any appends
       
       // Append 101 leaves to test circular buffer wraparound
       for i in 0..101 {
           let mut leaf = [0u8; 32];
           leaf[0] = ((i + 1) % 8) as u8;
           
           tree.append(leaf);
           all_roots.push(tree.root());
       }
       
       // After 101 appends, current_root_index will be 1 (101 % 100 = 1)
       assert_eq!(tree.get_current_root_index(), 1);
       
       // Get the final root history
       let root_history = tree.get_root_history();
       
       // The implementation stores each new root at the next index (after incrementing):
       // 1. The initial root is stored at root_history[0]
       // 2. Append #0 root is stored at root_history[1]
       // 3. Append #1 root is stored at root_history[2]
       // ...and so on
       
       // After 101 appends, the circular buffer should contain:
       // - Index 0: The root after append #99 (100th append, wrapping around to index 0)
       // - Index 1 is current_root_index (where next root would be stored)
       
       // Verify the final state of the buffer
       assert_eq!(root_history[0], all_roots[100], 
           "Root history at index 0 should be the root after the 100th append");

        assert_eq!(root_history[1], all_roots[101], 
            "Root history at index 0 should be the root after the 100th append");
           
       for i in 2..100 {
           assert_eq!(root_history[i], all_roots[i], 
               "Root history at index {} doesn't match expected root", i);
       }
    }
}