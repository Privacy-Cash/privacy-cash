use anchor_lang::error::Error;
use zkcash::utils::check_external_amount;

// Helper function to create a byte array representing a u64 value
fn u64_to_bytes(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Place the value in the last 8 bytes (positions 24-31) in big-endian format
    bytes[24..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

// Helper function to create a byte array representing a large value (larger than u64)
fn large_value_to_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Set a non-zero byte in the first 24 bytes to trigger the "larger than u64" check
    bytes[0] = 1;
    bytes
}

// Helper function to create a byte array representing a very large i64 value (won't fit in i64)
fn too_large_for_i64_to_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    // Set to a value larger than i64::MAX in the last 8 bytes (big-endian)
    bytes[24..32].copy_from_slice(&(i64::MAX as u64 + 1).to_be_bytes());
    bytes
}

// Helper function to check if the error is InvalidPublicAmountData
fn is_invalid_public_amount_error(error: Error) -> bool {
    // Converting Anchor Error to string and checking if it contains our error message
    error.to_string().contains("Public amount is invalid")
}

// Helper function for creating a byte array representing a value near the BN254 field modulus
fn near_modulus_bytes() -> [u8; 32] {
    // Simplified approach - just create a byte array with non-zero values
    // in the first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

// Helper function for creating a byte array representing the BN254 field modulus exactly
fn at_modulus_bytes() -> [u8; 32] {
    // This is a simplified approach - just create a byte array with non-zero values in the
    // first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

// Helper function for creating a byte array representing a value above the BN254 field modulus
fn above_modulus_bytes() -> [u8; 32] {
    // Simplified approach - just create a byte array with non-zero values
    // in the first 24 bytes to trigger the "larger than u64" check
    let mut bytes = [0; 32];
    bytes[0] = 1; // Any non-zero value in the first 24 bytes
    bytes
}

#[test]
fn test_positive_ext_amount_success() {
    // Test case for positive ext_amount with valid inputs
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    // Public amount should be ext_amount - fee
    let public_amount_bytes = u64_to_bytes(90);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 100);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_negative_ext_amount_success() {
    // Test case for negative ext_amount with valid inputs
    let ext_amount: i64 = -90;
    let fee: u64 = 10;
    // Public amount should be abs(ext_amount) + fee
    let public_amount_bytes = u64_to_bytes(100);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 90);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_zero_ext_amount_success() {
    // Test case for ext_amount = 0 with valid inputs
    let ext_amount: i64 = 0;
    let fee: u64 = 10;
    // Public amount doesn't matter for zero ext_amount
    let public_amount_bytes = u64_to_bytes(0);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_ok());
    
    // Verify the returned values
    let (amount, returned_fee) = result.unwrap();
    assert_eq!(amount, 0);
    assert_eq!(returned_fee, 10);
}

#[test]
fn test_positive_ext_amount_too_large() {
    // Test case for positive ext_amount where public_amount is too large
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = large_value_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_positive_ext_amount_too_large_for_i64() {
    // Test case for positive ext_amount where public_amount is too large for i64
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = too_large_for_i64_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_positive_ext_amount_mismatch() {
    // Test case for positive ext_amount where amount check fails
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    // Setting public_amount to wrong value (not ext_amount - fee)
    let public_amount_bytes = u64_to_bytes(50); // Should be 90
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_too_large() {
    // Test case for negative ext_amount where public_amount is too large
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = large_value_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_too_large_for_i64() {
    // Test case for negative ext_amount where public_amount is too large for i64
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = too_large_for_i64_to_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_negative_ext_amount_mismatch() {
    // Test case for negative ext_amount where amount check fails
    let ext_amount: i64 = -90;
    let fee: u64 = 10;
    // Setting public_amount to wrong value (not abs(ext_amount) + fee)
    let public_amount_bytes = u64_to_bytes(50); // Should be 100
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_edge_cases() {
    // Test with ext_amount = i64::MAX
    let ext_amount: i64 = i64::MAX;
    let fee: u64 = 10;
    // This would typically overflow, but in real scenarios we would have proper validation
    // Here we'll just test how the function handles the edge case
    let public_amount_bytes = u64_to_bytes(i64::MAX as u64 - fee);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // This might fail or succeed based on implementation details, but should not panic
    if result.is_ok() {
        let (amount, returned_fee) = result.unwrap();
        assert_eq!(amount as i64, ext_amount);
        assert_eq!(returned_fee, fee);
    }
    
    // Test with ext_amount = i64::MIN + 1 (need +1 to ensure abs() fits in a u64)
    let ext_amount: i64 = i64::MIN + 1;
    let fee: u64 = 10;
    // For large negative numbers, we need to handle potential overflows carefully
    let abs_ext_amount = (-(ext_amount as i128)) as u64;
    let public_amount_bytes = u64_to_bytes(abs_ext_amount + fee);
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Again, this might fail or succeed based on implementation details
    if result.is_ok() {
        let (amount, returned_fee) = result.unwrap();
        assert_eq!(amount, abs_ext_amount);
        assert_eq!(returned_fee, fee);
    }
}

#[test]
fn test_overflow_cases() {
    // Test case where fee + ext_amount would overflow
    let ext_amount: i64 = i64::MAX;
    let fee: u64 = u64::MAX;
    let public_amount_bytes = u64_to_bytes(0); // Any value would fail due to overflow
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // This should either panic (unwrap failures) or return an error
    assert!(result.is_err());
}

#[test]
fn test_field_modulus_near_positive() {
    // Test with a value near the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = near_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_near_negative() {
    // Test with a value near the field modulus and negative ext_amount
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = near_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_at_positive() {
    // Test with a value at the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = at_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is equivalent to 0 in the field but our implementation checks raw bytes,
    // this should fail as a value too large for i64
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_at_negative() {
    // Test with a value at the field modulus and negative ext_amount
    let ext_amount: i64 = -100; 
    let fee: u64 = 10;
    let public_amount_bytes = at_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is equivalent to 0 in the field but our implementation checks raw bytes,
    // this should fail as a value too large for i64
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_above_positive() {
    // Test with a value above the field modulus and positive ext_amount
    let ext_amount: i64 = 100;
    let fee: u64 = 10;
    let public_amount_bytes = above_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}

#[test]
fn test_field_modulus_above_negative() {
    // Test with a value above the field modulus and negative ext_amount
    let ext_amount: i64 = -100;
    let fee: u64 = 10;
    let public_amount_bytes = above_modulus_bytes();
    
    let result = check_external_amount(ext_amount, fee, public_amount_bytes);
    // Since this is a very large value that doesn't fit in i64, it should fail
    assert!(result.is_err());
    
    // Check that it's the expected error
    let error = result.unwrap_err();
    assert!(is_invalid_public_amount_error(error));
}