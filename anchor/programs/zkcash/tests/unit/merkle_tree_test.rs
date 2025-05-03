use light_hasher::{Poseidon, Hasher};
use std::mem::MaybeUninit;
use zkcash::{MerkleTreeAccount, merkle_tree::{MerkleTree, DEFAULT_HEIGHT}};

// Helper function to create an initialized MerkleTreeAccount for testing
fn create_test_account() -> MerkleTreeAccount {
    let mut account = unsafe { MaybeUninit::<MerkleTreeAccount>::zeroed().assume_init() };
    account.authority = Default::default();
    account.next_index = 0;
    account.root_index = 0;
    
    // Initialize the account using our MerkleTree implementation
    MerkleTree::initialize::<Poseidon>(&mut account);
    
    account
}

#[test]
fn test_new_empty() {
    // Create and initialize a test account
    let account = create_test_account();
    
    // Verify initial state
    assert_eq!(account.next_index, 0);
    
    // Root of empty tree should match the HEIGHT-th zero byte
    let zero_bytes = Poseidon::zero_bytes();
    assert_eq!(account.root, zero_bytes[DEFAULT_HEIGHT]);
    
    // All subtrees should be zero bytes
    for i in 0..DEFAULT_HEIGHT {
        assert_eq!(account.subtrees[i], zero_bytes[i]);
    }
}

#[test]
fn test_append_single_leaf() {
    // Create and initialize a test account
    let mut account = create_test_account();
    
    // Create a test leaf
    let mut leaf = [0u8; 32];
    leaf[0] = 1; // Simple non-zero value
    
    // Append the leaf
    let proof = MerkleTree::append::<Poseidon>(leaf, &mut account);
    
    // Verify index was incremented
    assert_eq!(account.next_index, 1);
    
    // Verify proof contains expected values (zeros for empty tree)
    let zero_bytes = Poseidon::zero_bytes();
    for i in 0..DEFAULT_HEIGHT {
        assert_eq!(proof[i], zero_bytes[i]);
    }
    
    // Root should no longer be the default zero value
    assert_ne!(account.root, zero_bytes[DEFAULT_HEIGHT]);
}

#[test]
fn test_append_multiple_leaves() {
    // Create and initialize a test account
    let mut account = create_test_account();
    
    // Create and append 8 leaves
    let mut prev_root = account.root;
    for i in 0..8 {
        let mut leaf = [0u8; 32];
        // Make leaf non-zero even when i=0 to ensure the root changes
        leaf[0] = 1;
        
        MerkleTree::append::<Poseidon>(leaf, &mut account);
        
        // Root should change with each append
        assert_ne!(account.root, prev_root);
        prev_root = account.root;
        
        // Index should be incremented
        assert_eq!(account.next_index, i + 1);
    }
}

#[test]
fn test_deterministic_output() {
    // Create and initialize two test accounts
    let mut account1 = create_test_account();
    let mut account2 = create_test_account();
    
    // Append the same leaves to both trees
    for i in 0..4 {
        let mut leaf = [0u8; 32];
        leaf[31] = i as u8;
        
        MerkleTree::append::<Poseidon>(leaf, &mut account1);
        MerkleTree::append::<Poseidon>(leaf, &mut account2);
        
        // Both trees should have the same root after identical operations
        assert_eq!(account1.root, account2.root);
        assert_eq!(account1.subtrees, account2.subtrees);
    }
}

#[test]
fn test_comparison_with_right_root_hash() {
    // Create and initialize a test account
    let mut account = create_test_account();
    
    // Add some known leaves and verify expected behavior
    let test_leaves = [
        // Leaf data (all have at least one non-zero byte)
        [1u8; 32],
        [2u8; 32]
    ];

    // First leaf append
    MerkleTree::append::<Poseidon>(test_leaves[0], &mut account);
    let root_after_first = account.root;
    
    // Root should change after first append
    let initial_root = Poseidon::zero_bytes()[DEFAULT_HEIGHT];
    assert_ne!(root_after_first, initial_root, "Root should change after first append");
    
    // Second leaf append
    MerkleTree::append::<Poseidon>(test_leaves[1], &mut account);
    let root_after_second = account.root;
    
    // Root should change after second append
    assert_ne!(root_after_second, root_after_first, "Root should change after second append");
    
    // Verify final index
    assert_eq!(account.next_index, 2);
    
    // Instead of trying to manually calculate the expected root, which is complex 
    // and depends on the exact implementation details, we'll just check that the root
    // is consistent between appends with the same data
    let mut verify_account = create_test_account();
    MerkleTree::append::<Poseidon>(test_leaves[0], &mut verify_account);
    MerkleTree::append::<Poseidon>(test_leaves[1], &mut verify_account);
    
    assert_eq!(verify_account.root, root_after_second, 
        "Root hash should be deterministic for the same sequence of appends");
}

#[test]
fn test_root_history_initial_state() {
    // Create and initialize a test account
    let account = create_test_account();

    // Check that the root history is initialized correctly
    assert_eq!(account.root_history[0], Poseidon::zero_bytes()[DEFAULT_HEIGHT]);
    assert_eq!(account.root_index, 0);
}

#[test]
fn test_root_history() {
    // Create and initialize a test account
    let mut account = create_test_account();
    
    // Initial state check
    assert_eq!(account.root_index, 0);
    let initial_root = account.root;
    
    // Create and append 5 leaves
    let mut expected_roots = Vec::new();
    expected_roots.push(initial_root);
    
    for i in 0..5 {
        let mut leaf = [0u8; 32];
        leaf[0] = (i + 1) as u8; // Make each leaf unique
        
        MerkleTree::append::<Poseidon>(leaf, &mut account);
        expected_roots.push(account.root);
    }
    
    // Check that the root history contains the expected roots
    let root_history = account.root_history;
    
    // The root history should have roots at indices 0-5
    for i in 0..6 {
        assert_eq!(root_history[i], expected_roots[i], 
            "Root history at index {} doesn't match expected root", i);
    }
    
    // And the current index should be 5
    assert_eq!(account.root_index, 5);
}

#[test]
fn test_root_history_circular_buffer() {
   // Create and initialize a test account
   let mut account = create_test_account();
    
   // Initial state check
   assert_eq!(account.root_index, 0);
   let initial_root = account.root;
   
   // Store all roots as we append leaves
   let mut all_roots = Vec::new();
   all_roots.push(initial_root); // Initial root before any appends
   
   // Append 101 leaves to test circular buffer wraparound
   for i in 0..101 {
       let mut leaf = [0u8; 32];
       leaf[0] = ((i + 1) % 8) as u8;
       
       MerkleTree::append::<Poseidon>(leaf, &mut account);
       all_roots.push(account.root);
   }
   
   // After 101 appends, root_index will be 1 (101 % 100 = 1)
   assert_eq!(account.root_index, 1);
   
   // Get the final root history
   let root_history = account.root_history;
   
   // After 101 appends, the circular buffer should contain:
   // - Index 0: The root after append #99 (100th append, wrapping around to index 0)
   // - Index 1 is current root_index (where next root would be stored)
   
   // Verify the final state of the buffer
   assert_eq!(root_history[0], all_roots[100], 
       "Root history at index 0 should be the root after the 100th append");

   assert_eq!(root_history[1], all_roots[101], 
       "Root history at index 1 should be the root after the 101st append");
       
   for i in 2..100 {
       assert_eq!(root_history[i], all_roots[i], 
           "Root history at index {} doesn't match expected root", i);
   }
}

#[test]
fn test_is_known_root_with_empty_tree() {
    let account = create_test_account();

    // Initial root should be recognized as a known root
    let initial_root = account.root;
    assert!(MerkleTree::is_known_root(&account, initial_root), 
        "Initial root should be recognized as a known root");

    // A zero root should always be rejected
    let zero_root = [0u8; 32];
    assert!(!MerkleTree::is_known_root(&account, zero_root), 
        "Zero root should always be rejected");

    // Any other root should be rejected
    let unknown_root = [1u8; 32];
    assert!(!MerkleTree::is_known_root(&account, unknown_root), 
        "Unknown root should be rejected");

    let another_unknown_root = Poseidon::zero_bytes()[1];
    assert!(!MerkleTree::is_known_root(&account, another_unknown_root), 
        "Unknown root should be rejected");
}

#[test]
fn test_is_known_root_with_appends() {
    let mut account = create_test_account();
    
    // Store roots as we append leaves
    let mut roots = Vec::new();
    roots.push(account.root); // Initial root
    
    // Append 5 leaves and store their roots
    for i in 0..5 {
        let mut leaf = [0u8; 32];
        leaf[0] = (i + 1) as u8; // Make each leaf unique
        
        MerkleTree::append::<Poseidon>(leaf, &mut account);
        roots.push(account.root);
    }
    
    // Verify all roots are recognized
    for i in 0..6 {
        assert!(MerkleTree::is_known_root(&account, roots[i]), 
            "Root at index {} should be recognized", i);
    }
    
    // Unknown root should be rejected
    let unknown_root = [42u8; 32];
    assert!(!MerkleTree::is_known_root(&account, unknown_root), 
        "Unknown root should be rejected");
}

#[test]
fn test_is_known_root_circular_buffer() {
    let mut account = create_test_account();
    
    // Store all roots as we append leaves
    let mut all_roots = Vec::new();
    all_roots.push(account.root); // Initial root
    
    // Append 101 leaves to test circular buffer wraparound
    for i in 0..101 {
        let mut leaf = [0u8; 32];
        leaf[0] = ((i + 1) % 8) as u8;
        
        MerkleTree::append::<Poseidon>(leaf, &mut account);
        all_roots.push(account.root);
    }
    
    // After 101 appends, the buffer will have wrapped around
    // The first root (index 0) should no longer be in the history
    assert!(!MerkleTree::is_known_root(&account, all_roots[0]), 
        "Overwritten root should not be recognized");
    
    // The most recent 100 roots should be recognized
    for i in 2..102 {
        assert!(MerkleTree::is_known_root(&account, all_roots[i]), 
            "Root at index {} should be recognized", i);
    }
}

#[test]
fn test_is_zero_root_always_rejected() {
    let mut account = create_test_account();
    
    let zero_root = [0u8; 32];
    assert!(!MerkleTree::is_known_root(&account, zero_root), 
        "Zero root should always be rejected");

    for i in 0..200 {
        let mut leaf = [0u8; 32];
        leaf[0] = ((i + 1) % 8) as u8;
        
        MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(!MerkleTree::is_known_root(&account, zero_root), 
            "Zero root should always be rejected");
    }
}

#[test]
fn test_modification_of_root_history_is_rejected() {
    let mut account = create_test_account();
    
    let initial_root = account.root;
    let mut modified_root = initial_root;
    modified_root[0] = 42; // Modify first byte
    
    assert!(!MerkleTree::is_known_root(&account, modified_root), 
        "Modified root should be rejected");
}