import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');
const SQUAD_VAULT_ADDRESS = new PublicKey('AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM');
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// Set to desired withdrawal fee in basis points (0 = 0%, 25 = 0.25%, 10000 = 100%)
const NEW_WITHDRAWAL_FEE_RATE = 0;

const connection = new Connection(RPC_URL, 'confirmed');

function generateUpdateGlobalConfigDiscriminator(): Buffer {
  const hash = crypto
    .createHash('sha256')
    .update('global:update_global_config')
    .digest();
  return hash.slice(0, 8);
}

/**
 * Anchor Option<u16> args for update_global_config:
 * - deposit_fee_rate: None
 * - withdrawal_fee_rate: Some(NEW_WITHDRAWAL_FEE_RATE)
 * - fee_error_margin: None
 */
function serializeUpdateGlobalConfigArgs(newWithdrawalFeeRate: number): Buffer {
  const depositFeeRate = Buffer.from([0]); // None
  const withdrawalFeeRateArg = Buffer.from([
    1, // Some
    newWithdrawalFeeRate & 0xff,
    (newWithdrawalFeeRate >> 8) & 0xff,
  ]);
  const feeErrorMargin = Buffer.from([0]); // None

  return Buffer.concat([depositFeeRate, withdrawalFeeRateArg, feeErrorMargin]);
}

function parseWithdrawalFeeRate(accountData: Buffer): number {
  // 8-byte discriminator + 32-byte authority + 2-byte deposit_fee_rate
  return accountData.readUInt16LE(42);
}

async function fetchCurrentWithdrawalFeeRate(globalConfig: PublicKey): Promise<number | null> {
  const accountInfo = await connection.getAccountInfo(globalConfig);
  if (!accountInfo?.data || accountInfo.data.length < 44) {
    return null;
  }

  return parseWithdrawalFeeRate(accountInfo.data);
}

async function generateSquadsTransaction() {
  console.log('SQUAD MULTISIG: SET WITHDRAWAL FEE RATE');
  console.log('='.repeat(60));
  console.log(`Program ID: ${PROGRAM_ID.toString()}`);
  console.log(`Squad Vault (authority): ${SQUAD_VAULT_ADDRESS.toString()}`);
  console.log(`New withdrawal fee rate: ${NEW_WITHDRAWAL_FEE_RATE} bps (${NEW_WITHDRAWAL_FEE_RATE / 100}%)`);
  console.log('');

  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PROGRAM_ID
  );

  const currentRate = await fetchCurrentWithdrawalFeeRate(globalConfig);
  console.log('Global Config PDA:');
  console.log(globalConfig.toString());
  console.log('');
  if (currentRate === null) {
    console.log('Current withdrawal fee rate: (unable to fetch)');
  } else {
    console.log(`Current withdrawal fee rate: ${currentRate} bps (${currentRate / 100}%)`);
  }
  console.log('');

  const discriminator = generateUpdateGlobalConfigDiscriminator();
  const args = serializeUpdateGlobalConfigArgs(NEW_WITHDRAWAL_FEE_RATE);
  const instructionData = Buffer.concat([discriminator, args]);

  console.log('Instruction discriminator (hex):');
  console.log(discriminator.toString('hex'));
  console.log('');
  console.log('Instruction args (hex):');
  console.log(args.toString('hex'));
  console.log('');
  console.log('Complete instruction data (hex):');
  console.log(instructionData.toString('hex'));
  console.log('');

  const updateInstruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: SQUAD_VAULT_ADDRESS, isSigner: true, isWritable: false },
    ],
    data: instructionData,
  });

  const transaction = new Transaction().add(updateInstruction);
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = SQUAD_VAULT_ADDRESS;

  const message = transaction.compileMessage();
  const base58Message = bs58.encode(message.serialize());

  console.log('Accounts:');
  console.log(`  1. global_config (writable): ${globalConfig.toString()}`);
  console.log(`  2. authority (signer): ${SQUAD_VAULT_ADDRESS.toString()}`);
  console.log('');
  console.log('SQUAD TRANSACTION (base58, ready to paste):');
  console.log('');
  console.log(base58Message);
  console.log('');
  console.log('After approval, verify on-chain:');
  console.log(`  withdrawal_fee_rate should be ${NEW_WITHDRAWAL_FEE_RATE}`);
}

generateSquadsTransaction().catch(console.error);
