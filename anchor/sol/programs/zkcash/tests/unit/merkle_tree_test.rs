use light_hasher::{Poseidon, Hasher};
use std::mem::MaybeUninit;
use zkcash::{MerkleTreeAccount, merkle_tree::MerkleTree};

fn create_test_account() -> MerkleTreeAccount {
    let mut uninit: MaybeUninit<MerkleTreeAccount> = MaybeUninit::uninit();
    
    // Initialize with default test values
    let height = 26u8; // Use the default height for tests
    let root_history_size = 100u8; // Use the default root history size for tests
    
    unsafe {
        let ptr = uninit.as_mut_ptr();
        std::ptr::write_bytes(ptr, 0, 1); // Zero-initialize the entire struct
        
        // Set the required fields
        (*ptr).height = height;
        (*ptr).root_history_size = root_history_size;
        (*ptr).next_index = 0;
        (*ptr).root_index = 0;
        
        uninit.assume_init()
    }
}

#[test]
fn test_tree_initialization() {
    let mut account = create_test_account();
    
    // Test with the configured height
    let result = MerkleTree::initialize::<Poseidon>(&mut account);
    assert!(result.is_ok(), "Tree initialization should succeed");
    
    // Verify initial state
    assert_eq!(account.next_index, 0);
    assert_eq!(account.root_index, 0);
    
    // Verify root is set to the height-level zero hash
    let zero_hashes = Poseidon::zero_bytes();
    let expected_root = zero_hashes[account.height as usize];
    assert_eq!(account.root, expected_root);
    assert_eq!(account.root_history[0], expected_root);
}

#[test]
fn test_single_append() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    let leaf = [1u8; 32];
    let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
    
    assert!(result.is_ok(), "Single append should succeed");
    assert_eq!(account.next_index, 1, "next_index should increment to 1");
    
    // Verify the proof length matches the tree height
    let proof = result.unwrap();
    assert_eq!(proof.len(), account.height as usize, "Proof length should match tree height");
}

#[test]
fn test_multiple_appends() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Append several leaves
    for i in 0..10 {
        let mut leaf = [0u8; 32];
        leaf[0] = i as u8;
        
        let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(result.is_ok(), "Append {} should succeed", i);
        assert_eq!(account.next_index, i + 1, "next_index should be {}", i + 1);
    }
}

#[test]
fn test_multiple_appends_verify_index_increments() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Start from a reasonable high value to test the arithmetic
    let start_index = 1000u64;
    account.next_index = start_index;
    
    // Append several leaves and verify each increment
    for i in 0..10 {
        let mut leaf = [0u8; 32];
        leaf[0] = i as u8;
        
        let expected_index = start_index + i;
        assert_eq!(account.next_index, expected_index, "next_index should be {} before append", expected_index);
        
        let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(result.is_ok(), "Append {} should succeed", i);
        assert_eq!(account.next_index, expected_index + 1, "next_index should be {} after append", expected_index + 1);
    }
}

#[test]
fn test_tree_full_capacity_check() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Calculate the maximum capacity: 2^height
    let max_capacity = 1u64 << account.height; // 2^height
    
    // Set next_index to one less than maximum capacity (should still allow one more append)
    account.next_index = max_capacity - 1;
    
    // Create a test leaf
    let leaf = [1u8; 32];
    
    // This append should succeed (we're at capacity-1, so one more is allowed)
    let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
    assert!(result.is_ok(), "Append should succeed when at capacity-1");
    assert_eq!(account.next_index, max_capacity, "next_index should equal max_capacity after append");
}

#[test]
fn test_tree_already_full() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Calculate the maximum capacity: 2^height
    let max_capacity = 1u64 << account.height; // 2^height
    
    // Set next_index to maximum capacity (tree is full)
    account.next_index = max_capacity;
    
    // Create a test leaf
    let leaf = [1u8; 32];
    
    // This append should fail (tree is full)
    let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
    assert!(result.is_err(), "Append should fail when tree is full");
    
    // Verify the error is the expected one
    let error = result.unwrap_err();
    match error {
        anchor_lang::error::Error::AnchorError(anchor_error) => {
            assert_eq!(anchor_error.error_code_number, 6016); // MerkleTreeFull error code
        }
        _ => {
            panic!("Expected AnchorError with MerkleTreeFull error code, got: {:?}", error);
        }
    }
}

#[test]
fn test_append_near_max_next_index() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Calculate the maximum capacity: 2^height
    let max_capacity = 1u64 << account.height; // 2^height
    
    // Set next_index to near the tree capacity limit (capacity - 2)
    account.next_index = max_capacity - 2;
    
    // Create a test leaf
    let leaf = [1u8; 32];
    
    // First append should succeed (we're at capacity-2)
    let result1 = MerkleTree::append::<Poseidon>(leaf, &mut account);
    assert!(result1.is_ok(), "First append should succeed");
    assert_eq!(account.next_index, max_capacity - 1, "next_index should be capacity-1");
    
    // Second append should succeed (we're at capacity-1)
    let result2 = MerkleTree::append::<Poseidon>(leaf, &mut account);
    assert!(result2.is_ok(), "Second append should succeed");
    assert_eq!(account.next_index, max_capacity, "next_index should be capacity");
    
    // Third append should fail (tree is now full)
    let result3 = MerkleTree::append::<Poseidon>(leaf, &mut account);
    assert!(result3.is_err(), "Third append should fail when tree is full");
}

#[test]
fn test_root_known_after_multiple_appends() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    // Store initial root
    let initial_root = account.root;
    assert!(MerkleTree::is_known_root(&account, initial_root), "Initial root should be known");
    
    // Append leaves and verify roots are stored in history
    let mut stored_roots = vec![initial_root];
    
    for i in 0..5 {
        let mut leaf = [0u8; 32];
        leaf[0] = i as u8;
        
        let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(result.is_ok(), "Append {} should succeed", i);
        
        let current_root = account.root;
        stored_roots.push(current_root);
        
        // Verify all previously stored roots are still known
        for (j, &root) in stored_roots.iter().enumerate() {
            assert!(MerkleTree::is_known_root(&account, root), 
                   "Root at position {} should be known", j);
        }
    }
}

#[test]
fn test_zero_root_not_known() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    let zero_root = [0u8; 32];
    assert!(!MerkleTree::is_known_root(&account, zero_root), "Zero root should never be considered known");
}

#[test]
fn test_unknown_root_not_known() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    let unknown_root = [255u8; 32]; // Arbitrary unknown root
    assert!(!MerkleTree::is_known_root(&account, unknown_root), "Unknown root should not be known");
}

#[test]
fn test_root_history_wraparound() {
    let mut account = create_test_account();
    // Use a small root history size for testing wraparound
    account.root_history_size = 3;
    
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);
    
    let initial_root = account.root;
    
    // Add enough entries to wrap around the history
    for i in 0..5 {
        let mut leaf = [0u8; 32];
        leaf[0] = i as u8;
        
        let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(result.is_ok(), "Append {} should succeed", i);
    }
    
    // The initial root should no longer be in history after wraparound
    assert!(!MerkleTree::is_known_root(&account, initial_root), 
           "Initial root should not be known after history wraparound");
    
    // But the current root should be known
    assert!(MerkleTree::is_known_root(&account, account.root), 
           "Current root should be known");
}