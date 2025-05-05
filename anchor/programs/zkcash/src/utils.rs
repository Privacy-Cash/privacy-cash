use anchor_lang::prelude::*;
use ark_ff::biginteger::BigInteger256;
use crate::ErrorCode;

pub fn check_external_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> Result<(u64, u64)> {
    let mut pub_amount = BigInteger256::new([0u64; 4]);
    for (i, chunk) in public_amount_bytes.chunks(8).enumerate() {
        if i >= 4 { break; } // BigInteger256 has 4 u64 values
        
        let mut val = 0u64;
        for (j, byte) in chunk.iter().enumerate() {
            if j < 8 { // Ensure we don't go beyond 8 bytes for a u64
                val |= (*byte as u64) << (j * 8);
            }
        }
        pub_amount.0[i] = val;
    }

    if ext_amount > 0 {
        if pub_amount.0[1] != 0 || pub_amount.0[2] != 0 || pub_amount.0[3] != 0 {
            msg!("Public amount is larger than u64.");
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }

        let pub_amount_fits_i64 = i64::try_from(pub_amount.0[0]);

        if pub_amount_fits_i64.is_err() {
            msg!("Public amount is larger than i64.");
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }

        // Convert ext_amount to u64 safely
        let ext_amount_u64: u64 = ext_amount.try_into().unwrap();
        
        //check amount
        if pub_amount.0[0].checked_add(fee).unwrap() != ext_amount_u64 {
            msg!(
                "Deposit invalid external amount (fee) {} != {}",
                pub_amount.0[0] + fee,
                ext_amount
            );
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }
        Ok((ext_amount_u64, fee))
    } else if ext_amount < 0 {
        if pub_amount.0[1] != 0 || pub_amount.0[2] != 0 || pub_amount.0[3] != 0 {
            msg!("Public amount is larger than u64.");
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }
        
        let pub_amount_fits_i64 = i64::try_from(pub_amount.0[0]);
        if pub_amount_fits_i64.is_err() {
            msg!("Public amount is larger than i64.");
            return Err(ErrorCode::InvalidPublicAmountData.into());
        }

        let ext_amount_abs: u64 = u64::try_from(-ext_amount).unwrap();
        
        if pub_amount.0[0] != ext_amount_abs.checked_add(fee).unwrap() {
            msg!(
                "Withdrawal invalid external amount: {} != {}",
                pub_amount.0[0],
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