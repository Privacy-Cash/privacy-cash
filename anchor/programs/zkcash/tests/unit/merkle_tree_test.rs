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
    
    // before append
    let light_hasher_v2_hashed_result_before_insert = [18, 12, 88, 241, 67, 212, 145, 233, 89, 2, 247, 245, 39, 119, 120, 162, 224, 173, 81, 104, 246, 173, 215, 86, 105, 147, 38, 48, 206, 97, 21, 24];
    assert_eq!(account.root, light_hasher_v2_hashed_result_before_insert, "root is wrong at index 0");

    
    let leaf = [1u8; 32];
    let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
    
    assert!(result.is_ok(), "Single append should succeed");
    assert_eq!(account.next_index, 1, "next_index should increment to 1");

    // verify the hash matches light-hasher v2 hashed result
    let light_hasher_v2_hashed_result_after_insert = [12, 153, 158, 15, 38, 45, 179, 85, 251, 119, 180, 90, 10, 154, 190, 24, 8, 111, 79, 137, 115, 214, 55, 24, 182, 136, 247, 221, 213, 247, 36, 149];
    assert_eq!(account.root, light_hasher_v2_hashed_result_after_insert, "root is wrong after append");
    
    // Verify the proof length matches the tree height
    let proof = result.unwrap();
    assert_eq!(proof.len(), account.height as usize, "Proof length should match tree height");
}

#[test]
fn test_multiple_appends() {
    let mut account = create_test_account();
    let _ = MerkleTree::initialize::<Poseidon>(&mut account);

    // before append
    let light_hasher_v2_hashed_result_before_insert = [18, 12, 88, 241, 67, 212, 145, 233, 89, 2, 247, 245, 39, 119, 120, 162, 224, 173, 81, 104, 246, 173, 215, 86, 105, 147, 38, 48, 206, 97, 21, 24];
    assert_eq!(account.root, light_hasher_v2_hashed_result_before_insert, "root is wrong at index 0");
    
    const MERKLE_TREE_ROOTS_FROM_V2_LIGHT_HASHER: [[u8; 32]; 10] = [
        [18, 12, 88, 241, 67, 212, 145, 233, 89, 2, 247, 245, 39, 119, 120, 162, 224, 173, 81, 104, 246, 173, 215, 86, 105, 147, 38, 48, 206, 97, 21, 24], // After append 0
        [34, 198, 39, 19, 222, 148, 140, 13, 41, 87, 36, 157, 11, 149, 48, 178, 247, 144, 167, 174, 165, 20, 241, 169, 90, 74, 26, 96, 228, 176, 141, 210], // After append 1
        [42, 86, 176, 201, 214, 30, 138, 115, 93, 82, 88, 125, 173, 77, 151, 183, 132, 181, 203, 27, 82, 155, 156, 51, 26, 177, 242, 18, 43, 228, 20, 210], // After append 2
        [25, 20, 85, 197, 190, 131, 125, 28, 137, 87, 101, 244, 143, 213, 2, 201, 101, 79, 146, 67, 66, 129, 214, 217, 227, 63, 27, 92, 132, 189, 186, 14], // After append 3
        [28, 47, 32, 165, 230, 34, 188, 126, 148, 11, 182, 146, 88, 218, 122, 8, 142, 158, 78, 54, 196, 61, 234, 218, 80, 96, 39, 126, 164, 92, 94, 159], // After append 4
        [47, 246, 84, 37, 196, 163, 6, 66, 83, 175, 126, 234, 43, 5, 107, 121, 179, 216, 156, 102, 131, 178, 240, 237, 19, 18, 174, 253, 120, 179, 128, 80], // After append 5
        [43, 187, 197, 213, 112, 109, 56, 137, 237, 118, 229, 182, 92, 190, 227, 186, 53, 121, 108, 201, 155, 165, 33, 131, 206, 39, 50, 172, 50, 106, 17, 159], // After append 6
        [13, 25, 28, 98, 81, 156, 228, 146, 151, 182, 71, 138, 128, 176, 211, 192, 91, 132, 197, 167, 184, 222, 54, 254, 106, 0, 248, 97, 154, 56, 138, 171], // After append 7
        [44, 188, 169, 160, 44, 86, 135, 122, 142, 60, 181, 145, 41, 216, 86, 217, 133, 236, 255, 61, 50, 248, 84, 47, 102, 197, 91, 172, 248, 223, 84, 156], // After append 8
        [46, 138, 129, 105, 53, 181, 43, 61, 4, 221, 147, 51, 54, 37, 17, 158, 36, 14, 63, 65, 213, 120, 101, 80, 176, 23, 13, 137, 148, 65, 71, 244], // After append 9
    ];
    
    // Append several leaves
    for i in 0..10 {
        let mut leaf = [0u8; 32];
        leaf[0] = i as u8;
        
        let result = MerkleTree::append::<Poseidon>(leaf, &mut account);
        assert!(result.is_ok(), "Append {} should succeed", i);
        assert_eq!(account.next_index, i + 1, "next_index should be {}", i + 1);
        assert_eq!(account.root, MERKLE_TREE_ROOTS_FROM_V2_LIGHT_HASHER[i as usize], "root is wrong at index {}", i);
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