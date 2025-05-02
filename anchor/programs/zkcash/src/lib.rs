use anchor_lang::prelude::*;

declare_id!("3HVWHCtT2p55t2vVXwV77YwgTxHp8sjXPGgoXzGxbRxr");

#[program]
pub mod anchor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
