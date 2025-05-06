use anchor_lang::prelude::*;
use crate::ErrorCode;

// ext_amount is the amount the user wants to deposit or withdraw, it includes the fee.
// public_amount is the absolute amount changed in the pool, and is always positive.
// thus, if ext_amount is positive, public_amount = ext_amount - fee
// if ext_amount is negative, public_amount = -ext_amount - fee
pub fn check_external_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> Result<(u64, u64)> {
    // Check that the first 24 bytes are all 0 (for a u64 value)
    for i in 0..24 {
        if public_amount_bytes[i] != 0 {
            msg!("Public amount is larger than u64.");
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }
    }
    
    // Extract the u64 value from the last 8 bytes (big-endian format)
    let mut public_amount_bytes_u64 = [0u8; 8];
    public_amount_bytes_u64.copy_from_slice(&public_amount_bytes[24..32]);
    
    // Convert from big-endian bytes to u64
    let public_amount = u64::from_be_bytes(public_amount_bytes_u64);
    
    // Check if the value fits in i64
    if public_amount > i64::MAX as u64 {
        msg!("Public amount is larger than i64.");
        return Err(ErrorCode::InvalidPublicAmountData.into());
    }
    
    if ext_amount > 0 {
        // Convert ext_amount to u64 safely
        let ext_amount_u64: u64 = ext_amount.try_into().unwrap();
        
        //check amount
        if public_amount.checked_add(fee).unwrap() != ext_amount_u64 {
            msg!(
                "Deposit invalid external amount (fee) {} != {}",
                public_amount + fee,
                ext_amount
            );
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }
        Ok((ext_amount_u64, fee))
    } else if ext_amount < 0 {
        // Convert negative ext_amount to positive u64
        let ext_amount_abs: u64 = u64::try_from(-ext_amount).unwrap();
        
        if public_amount != ext_amount_abs.checked_add(fee).unwrap() {
            msg!(
                "Withdrawal invalid external amount: {} != {}",
                public_amount,
                fee + ext_amount_abs
            );
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }
        Ok((ext_amount_abs, fee))
    } else if ext_amount == 0 {
        Ok((0, fee))
    } else {
        msg!("Invalid state checking external amount.");
        Err(ErrorCode::InvalidPublicAmountData.into())
    }
} 