import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection, EpochInfo, Keypair, PublicKey, Signer, SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';

import {
  Base, ComputeBudgetConfig, fetchMultipleMintInfos, getTransferAmountFee,
  GetTransferAmountFee, InnerTransaction, InstructionType,
  MakeInstructionOutType, minExpirationTime, ReturnTypeFetchMultipleMintInfos,
  TokenAccount, TransferAmountFee, TxVersion,
} from '../base';
import { addComputeBudget } from '../base/instrument';
import { getATAAddress } from '../base/pda';
import { ApiAmmV3PoolsItem, ApiAmmV3PoolsItemStatistics } from '../baseInfo';
import {
  getMultipleAccountsInfo, getMultipleAccountsInfoWithCustomFlags, Logger,
  splitTxAndSigners, TOKEN_PROGRAM_ID,
} from '../common';
import {
  Currency, CurrencyAmount, ONE, Percent, Price, Token, TokenAmount, ZERO,
} from '../entity';
import { SPL_ACCOUNT_LAYOUT } from '../spl';

import {
  closePositionInstruction, collectRewardInstruction, createPoolInstruction,
  decreaseLiquidityInstruction, increasePositionFromBaseInstruction,
  increasePositionFromLiquidityInstruction, initRewardInstruction,
  openPositionFromBaseInstruction, openPositionFromLiquidityInstruction,
  setRewardInstruction, swapInstruction,
} from './instrument';
import {
  ObservationInfoLayout, OperationLayout, PoolInfoLayout, PositionInfoLayout,
  TickArrayLayout,
} from './layout';
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64 } from './utils/constants';
import { LiquidityMath, MathUtil, SqrtPriceMath, TickMath } from './utils/math';
import {
  getPdaMetadataKey, getPdaOperationAccount, getPdaPersonalPositionAddress,
  getPdaPoolId, getPdaPoolRewardVaulId, getPdaPoolVaultId,
  getPdaProtocolPositionAddress, getPdaTickArrayAddress,
} from './utils/pda';
import { PoolUtils } from './utils/pool';
import { PositionUtils } from './utils/position';
import { Tick, TickArray, TickUtils } from './utils/tick';
import { FETCH_TICKARRAY_COUNT } from './utils/tickQuery';

const logger = Logger.from("AmmV3");

export interface AmmV3ConfigInfo {
  id: PublicKey;
  index: number;
  protocolFeeRate: number;
  tradeFeeRate: number;
  tickSpacing: number;
  fundFeeRate: number;
  fundOwner: string;
  description: string;
}

export interface AmmV3PoolRewardLayoutInfo {
  rewardState: number;
  openTime: BN;
  endTime: BN;
  lastUpdateTime: BN;
  emissionsPerSecondX64: BN;
  rewardTotalEmissioned: BN;
  rewardClaimed: BN;
  tokenMint: PublicKey;
  tokenVault: PublicKey;
  creator: PublicKey;
  rewardGrowthGlobalX64: BN;
}

export interface AmmV3PoolRewardInfo {
  rewardState: number;
  openTime: BN;
  endTime: BN;
  lastUpdateTime: BN;
  emissionsPerSecondX64: BN;
  rewardTotalEmissioned: BN;
  rewardClaimed: BN;
  tokenProgramId: PublicKey;
  tokenMint: PublicKey;
  tokenVault: PublicKey;
  creator: PublicKey;
  rewardGrowthGlobalX64: BN;
  perSecond: Decimal;
  remainingRewards: undefined | BN
}
export interface AmmV3PoolInfo {
  id: PublicKey,
  mintA: {
    programId: PublicKey,
    mint: PublicKey,
    vault: PublicKey,
    decimals: number
  },
  mintB: {
    programId: PublicKey,
    mint: PublicKey,
    vault: PublicKey,
    decimals: number
  },

  ammConfig: AmmV3ConfigInfo,
  observationId: PublicKey,

  creator: PublicKey,
  programId: PublicKey,
  version: 6,

  tickSpacing: number,
  liquidity: BN,
  sqrtPriceX64: BN,
  currentPrice: Decimal,
  tickCurrent: number,
  observationIndex: number,
  observationUpdateDuration: number,
  feeGrowthGlobalX64A: BN,
  feeGrowthGlobalX64B: BN,
  protocolFeesTokenA: BN,
  protocolFeesTokenB: BN,
  swapInAmountTokenA: BN,
  swapOutAmountTokenB: BN,
  swapInAmountTokenB: BN,
  swapOutAmountTokenA: BN,
  tickArrayBitmap: BN[]

  rewardInfos: AmmV3PoolRewardInfo[]

  day: ApiAmmV3PoolsItemStatistics,
  week: ApiAmmV3PoolsItemStatistics,
  month: ApiAmmV3PoolsItemStatistics,
  tvl: number

  lookupTableAccount: PublicKey

  startTime: number
}
export interface AmmV3PoolPersonalPosition {
  poolId: PublicKey,
  nftMint: PublicKey,

  priceLower: Decimal,
  priceUpper: Decimal,
  amountA: BN,
  amountB: BN
  tickLower: number
  tickUpper: number
  liquidity: BN
  feeGrowthInsideLastX64A: BN
  feeGrowthInsideLastX64B: BN
  tokenFeesOwedA: BN
  tokenFeesOwedB: BN
  rewardInfos: {
    growthInsideLastX64: BN;
    rewardAmountOwed: BN;
    pendingReward: BN
  }[]

  leverage: number
  tokenFeeAmountA: BN,
  tokenFeeAmountB: BN,
}

export interface MintInfo {
  mint: PublicKey,
  decimals: number,
  programId: PublicKey,
}

export interface ReturnTypeGetLiquidityAmountOut {
  liquidity: BN,
  amountSlippageA: GetTransferAmountFee,
  amountSlippageB: GetTransferAmountFee,
  amountA: GetTransferAmountFee,
  amountB: GetTransferAmountFee,
  expirationTime: number | undefined,
}

export interface ReturnTypeGetPriceAndTick {
  tick: number,
  price: Decimal
}
export interface ReturnTypeGetTickPrice {
  tick: number,
  price: Decimal,
  tickSqrtPriceX64: BN
}
export interface ReturnTypeComputeAmountOutFormat {
  realAmountIn: TransferAmountFee,
  amountOut: TransferAmountFee,
  minAmountOut: TransferAmountFee,
  expirationTime: number | undefined,
  currentPrice: Price,
  executionPrice: Price,
  priceImpact: Percent,
  fee: CurrencyAmount,
  remainingAccounts: PublicKey[]
}
export interface ReturnTypeComputeAmountOut {
  realAmountIn: GetTransferAmountFee,
  amountOut: GetTransferAmountFee,
  minAmountOut: GetTransferAmountFee,
  expirationTime: number | undefined,
  currentPrice: Decimal,
  executionPrice: Decimal,
  priceImpact: Percent,
  fee: BN,
  remainingAccounts: PublicKey[]
}
export interface ReturnTypeComputeAmountOutBaseOut {
  amountIn: GetTransferAmountFee,
  maxAmountIn: GetTransferAmountFee,
  realAmountOut: GetTransferAmountFee,
  expirationTime: number | undefined,
  currentPrice: Decimal,
  executionPrice: Decimal,
  priceImpact: Percent,
  fee: BN,
  remainingAccounts: PublicKey[]
}
export interface ReturnTypeFetchMultiplePoolInfos {
  [id: string]: {
    state: AmmV3PoolInfo;
    positionAccount?: AmmV3PoolPersonalPosition[] | undefined;
  };
}
export interface ReturnTypeFetchMultiplePoolTickArrays { [poolId: string]: { [key: string]: TickArray } }

export class AmmV3 extends Base {
  static makeMockPoolInfo({
    programId,
    mint1,
    mint2,
    ammConfig,
    createPoolInstructionSimpleAddress,
    initialPrice,
    startTime,
    owner
  }: {
    programId: PublicKey,
    mint1: MintInfo,
    mint2: MintInfo,
    ammConfig: AmmV3ConfigInfo,

    createPoolInstructionSimpleAddress: {
      observationId: PublicKey,
      poolId: PublicKey,
      mintAVault: PublicKey,
      mintBVault: PublicKey,
      mintA: PublicKey,
      mintB: PublicKey
      mintProgramIdA: PublicKey,
      mintProgramIdB: PublicKey
    },
    initialPrice: Decimal,
    startTime: BN,
    owner: PublicKey,
  }): AmmV3PoolInfo {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const [mintA, mintB, initPrice] = mint1.mint._bn.gt(mint2.mint._bn) ? [mint2, mint1, (new Decimal(1)).div(initialPrice)] : [mint1, mint2, initialPrice];

    const initialPriceX64 = SqrtPriceMath.priceToSqrtPriceX64(initPrice, mintA.decimals, mintB.decimals);

    return {
      id: createPoolInstructionSimpleAddress.poolId,
      mintA: {
        programId: createPoolInstructionSimpleAddress.mintProgramIdA,
        mint: createPoolInstructionSimpleAddress.mintA,
        vault: createPoolInstructionSimpleAddress.mintAVault,
        decimals: mintA.decimals
      },
      mintB: {
        programId: createPoolInstructionSimpleAddress.mintProgramIdB,
        mint: createPoolInstructionSimpleAddress.mintB,
        vault: createPoolInstructionSimpleAddress.mintBVault,
        decimals: mintB.decimals
      },

      ammConfig,
      observationId: createPoolInstructionSimpleAddress.observationId,

      creator: owner,
      programId,
      version: 6,

      tickSpacing: ammConfig.tickSpacing,
      liquidity: ZERO,
      sqrtPriceX64: initialPriceX64,
      currentPrice: initPrice,
      tickCurrent: 0,
      observationIndex: 0,
      observationUpdateDuration: 0,
      feeGrowthGlobalX64A: ZERO,
      feeGrowthGlobalX64B: ZERO,
      protocolFeesTokenA: ZERO,
      protocolFeesTokenB: ZERO,
      swapInAmountTokenA: ZERO,
      swapOutAmountTokenB: ZERO,
      swapInAmountTokenB: ZERO,
      swapOutAmountTokenA: ZERO,
      tickArrayBitmap: [],

      rewardInfos: [],

      day: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, rewardApr: { A: 0, B: 0, C: 0 }, apr: 0, priceMax: 0, priceMin: 0 },
      week: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, rewardApr: { A: 0, B: 0, C: 0 }, apr: 0, priceMax: 0, priceMin: 0 },
      month: { volume: 0, volumeFee: 0, feeA: 0, feeB: 0, feeApr: 0, rewardApr: { A: 0, B: 0, C: 0 }, apr: 0, priceMax: 0, priceMin: 0 },
      tvl: 0,

      lookupTableAccount: PublicKey.default,

      startTime: startTime.toNumber(),
    }
  }

  // transaction
  static async makeCreatePoolInstructionSimple({
    connection,
    programId,
    owner,
    mint1,
    mint2,
    ammConfig,
    initialPrice,
    startTime,
    computeBudgetConfig
  }: {
    connection: Connection,
    programId: PublicKey,
    owner: PublicKey,
    mint1: MintInfo,
    mint2: MintInfo,
    ammConfig: AmmV3ConfigInfo,
    initialPrice: Decimal,
    startTime: BN,
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const [mintA, mintB, initPrice] = mint1.mint._bn.gt(mint2.mint._bn) ? [mint2, mint1, (new Decimal(1)).div(initialPrice)] : [mint1, mint2, initialPrice];

    const initialPriceX64 = SqrtPriceMath.priceToSqrtPriceX64(initPrice, mintA.decimals, mintB.decimals);

    const makeCreatePoolInstructions = await this.makeCreatePoolInstructions({
      connection,
      programId,
      owner,
      mintA,
      mintB,
      ammConfigId: ammConfig.id,
      initialPriceX64,
      startTime
    })

    return {
      address: { ...makeCreatePoolInstructions.address, mintA: mintA.mint, mintB: mintB.mint, mintProgramIdA: mintA.programId, mintProgramIdB: mintB.programId },
      innerTransactions: [{
        instructions: [...instructions, ...makeCreatePoolInstructions.innerTransaction.instructions],
        signers: makeCreatePoolInstructions.innerTransaction.signers,
        instructionTypes: [...instructionTypes, ...makeCreatePoolInstructions.innerTransaction.instructionTypes],
        supportedVersion: makeCreatePoolInstructions.innerTransaction.supportedVersion
      }]
    }
  }

  static async makeOpenPositionFromLiquidityInstructionSimple(
    { connection, poolInfo, ownerInfo, amountMaxA, amountMaxB, tickLower, tickUpper, liquidity, associatedOnly = true, checkCreateATAOwner = false, computeBudgetConfig, withMetadata = 'create' }: {
      connection: Connection,
      poolInfo: AmmV3PoolInfo,

      ownerInfo: {
        feePayer: PublicKey,
        wallet: PublicKey,
        tokenAccounts: TokenAccount[],
        useSOLBalance?: boolean  // if has WSOL mint (default: true)
      },

      amountMaxA: BN,
      amountMaxB: BN,

      tickLower: number,
      tickUpper: number,

      withMetadata?: 'create' | 'no-create',

      liquidity: BN,
      slippage: number
      associatedOnly?: boolean,
      checkCreateATAOwner?: boolean,
      computeBudgetConfig?: ComputeBudgetConfig,
    }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)
    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: amountMaxA,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: amountMaxB,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      ownerTokenAccountA !== undefined && ownerTokenAccountB !== undefined,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeOpenPositionInstructions = this.makeOpenPositionFromLiquidityInstructions({
      poolInfo,
      ownerInfo: {
        ...ownerInfo,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },
      tickLower,
      tickUpper,
      liquidity,
      amountMaxA,
      amountMaxB,
      withMetadata,
    })

    return {
      address: makeOpenPositionInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeOpenPositionInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeOpenPositionInstructions.innerTransaction.signers],
          lookupTableAddress: makeOpenPositionInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeOpenPositionInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeOpenPositionInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeOpenPositionFromBaseInstructionSimple(
    { connection, poolInfo, ownerInfo, tickLower, tickUpper, base, baseAmount, otherAmountMax, associatedOnly = true, checkCreateATAOwner = false, computeBudgetConfig, withMetadata = 'create' }: {
      connection: Connection,
      poolInfo: AmmV3PoolInfo,

      ownerInfo: {
        feePayer: PublicKey,
        wallet: PublicKey,
        tokenAccounts: TokenAccount[],
        useSOLBalance?: boolean  // if has WSOL mint (default: true)
      },
      
      tickLower: number,
      tickUpper: number,

      withMetadata?: 'create' | 'no-create',

      base: 'MintA' | 'MintB',
      baseAmount: BN,
      otherAmountMax: BN,

      associatedOnly?: boolean,
      checkCreateATAOwner?: boolean,
      computeBudgetConfig?: ComputeBudgetConfig,
    }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)
    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: base === 'MintA'? baseAmount : otherAmountMax,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: base === 'MintA'? otherAmountMax : baseAmount,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      ownerTokenAccountA !== undefined && ownerTokenAccountB !== undefined,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeOpenPositionInstructions = this.makeOpenPositionFromBaseInstructions({
      poolInfo,
      ownerInfo: {
        ...ownerInfo,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },
      tickLower,
      tickUpper,

      base,
      baseAmount,
      otherAmountMax,

      withMetadata,
    })

    return {
      address: makeOpenPositionInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeOpenPositionInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeOpenPositionInstructions.innerTransaction.signers],
          lookupTableAddress: makeOpenPositionInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeOpenPositionInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeOpenPositionInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeIncreasePositionFromLiquidityInstructionSimple({
    connection, poolInfo, ownerPosition, ownerInfo, amountMaxA, amountMaxB, liquidity, associatedOnly = true, checkCreateATAOwner = false, computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    amountMaxA: BN,
    amountMaxB: BN,

    liquidity: BN,
    associatedOnly?: boolean,
    checkCreateATAOwner?: boolean,
    computeBudgetConfig?: ComputeBudgetConfig,
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)
    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: amountMaxA,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: amountMaxB,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      !!ownerTokenAccountA || !!ownerTokenAccountB,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeIncreaseLiquidityInstructions = this.makeIncreasePositionFromLiquidityInstructions({
      poolInfo,
      ownerPosition,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },
      liquidity,
      amountMaxA,
      amountMaxB,
    })

    return {
      address: makeIncreaseLiquidityInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeIncreaseLiquidityInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeIncreaseLiquidityInstructions.innerTransaction.signers],
          lookupTableAddress: makeIncreaseLiquidityInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeIncreaseLiquidityInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeIncreaseLiquidityInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeIncreasePositionFromBaseInstructionSimple({
    connection, poolInfo, ownerPosition, ownerInfo, base, baseAmount, otherAmountMax, associatedOnly = true, checkCreateATAOwner = false, computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    base: 'MintA' | 'MintB',
    baseAmount: BN,
    otherAmountMax: BN,

    associatedOnly?: boolean,
    checkCreateATAOwner?: boolean,
    computeBudgetConfig?: ComputeBudgetConfig,
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)
    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: base === 'MintA'? baseAmount : otherAmountMax,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: base === 'MintA'? otherAmountMax : baseAmount,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      !!ownerTokenAccountA || !!ownerTokenAccountB,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeIncreaseLiquidityInstructions = this.makeIncreasePositionFromBaseInstructions({
      poolInfo,
      ownerPosition,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },

      base,
      baseAmount,
      otherAmountMax,
    })

    return {
      address: makeIncreaseLiquidityInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeIncreaseLiquidityInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeIncreaseLiquidityInstructions.innerTransaction.signers],
          lookupTableAddress: makeIncreaseLiquidityInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeIncreaseLiquidityInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeIncreaseLiquidityInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeDecreaseLiquidityInstructionSimple({
    connection, poolInfo, ownerPosition, ownerInfo, liquidity, amountMinA, amountMinB, associatedOnly = true, checkCreateATAOwner = false, computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
      closePosition?: boolean
    },

    liquidity: BN,
    amountMinA: BN,
    amountMinB: BN,

    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];
    const signers: Signer[] = []

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)

    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: {
        connection,
        payer: ownerInfo.feePayer,
        amount: 0,

        frontInstructions,
        frontInstructionsType,
        endInstructions: mintAUseSOLBalance ? endInstructions : [],
        endInstructionsType: mintAUseSOLBalance ? endInstructionsType : [],
        signers
      },

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: {
        connection,
        payer: ownerInfo.feePayer,
        amount: 0,

        frontInstructions,
        frontInstructionsType,
        endInstructions: mintBUseSOLBalance ? endInstructions : [],
        endInstructionsType: mintBUseSOLBalance ? endInstructionsType : [],
        signers
      },

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const rewardAccounts: PublicKey[] = []
    for (const itemReward of poolInfo.rewardInfos) {
      const rewardUseSOLBalance = ownerInfo.useSOLBalance && itemReward.tokenMint.equals(Token.WSOL.mint)

      const ownerRewardAccount = await this._selectOrCreateTokenAccount({
        programId: itemReward.tokenProgramId,
        mint: itemReward.tokenMint,
        tokenAccounts: rewardUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,

        createInfo: {
          connection,
          payer: ownerInfo.feePayer,
          amount: 0,

          frontInstructions,
          frontInstructionsType,
          endInstructions: rewardUseSOLBalance ? endInstructions : [],
          endInstructionsType: rewardUseSOLBalance ? endInstructionsType : [],
          signers
        },

        associatedOnly: rewardUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })
      rewardAccounts.push(ownerRewardAccount)
    }

    logger.assertArgument(
      !!ownerTokenAccountA || !!ownerTokenAccountB,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeDecreaseLiquidityInstructions = this.makeDecreaseLiquidityInstructions({
      poolInfo,
      ownerPosition,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB,
        rewardAccounts
      },
      liquidity,
      amountMinA,
      amountMinB,
    })

    const makeClosePositionInstructions: MakeInstructionOutType = ownerInfo.closePosition ? this.makeClosePositionInstructions({
      poolInfo, ownerInfo, ownerPosition
    }) : { address: {}, innerTransaction: { instructions: [], signers: [], instructionTypes: [], supportedVersion: [] } }

    return {
      address: makeDecreaseLiquidityInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeDecreaseLiquidityInstructions.innerTransaction.instructions, ...endInstructions, ...makeClosePositionInstructions.innerTransaction.instructions],
          signers: [...signers, ...makeDecreaseLiquidityInstructions.innerTransaction.signers],
          lookupTableAddress: makeDecreaseLiquidityInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeDecreaseLiquidityInstructions.innerTransaction.instructionTypes, ...endInstructionsType, ...makeClosePositionInstructions.innerTransaction.instructionTypes],
          supportedVersion: makeDecreaseLiquidityInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeSwapBaseInInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,

    inputMint,
    amountIn,
    amountOutMin,
    priceLimit,

    remainingAccounts,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    inputMint: PublicKey,
    amountIn: BN,
    amountOutMin: BN,
    priceLimit?: Decimal

    remainingAccounts: PublicKey[]
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    let sqrtPriceLimitX64: BN;
    if (!priceLimit || priceLimit.equals(new Decimal(0))) {
      sqrtPriceLimitX64 = inputMint.equals(poolInfo.mintA.mint)
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(
        priceLimit,
        poolInfo.mintA.decimals,
        poolInfo.mintB.decimals
      );
    }

    const isInputMintA = poolInfo.mintA.mint.equals(inputMint)

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)
    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance || !isInputMintA ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: isInputMintA ? amountIn : 0,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance || isInputMintA ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: isInputMintA ? 0 : amountIn,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      !!ownerTokenAccountA || !!ownerTokenAccountB,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeSwapBaseInInstructions = this.makeSwapBaseInInstructions({
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },

      inputMint,

      amountIn,
      amountOutMin,
      sqrtPriceLimitX64,

      remainingAccounts,
    })

    return {
      address: makeSwapBaseInInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeSwapBaseInInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeSwapBaseInInstructions.innerTransaction.signers],
          lookupTableAddress: makeSwapBaseInInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeSwapBaseInInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeSwapBaseInInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeSwapBaseOutInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,

    outputMint,
    amountOut,
    amountInMax,
    priceLimit,

    remainingAccounts,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    outputMint: PublicKey,
    amountOut: BN,
    amountInMax: BN,
    priceLimit?: Decimal

    remainingAccounts: PublicKey[]
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    let sqrtPriceLimitX64: BN;
    if (!priceLimit || priceLimit.equals(new Decimal(0))) {
      sqrtPriceLimitX64 = outputMint.equals(poolInfo.mintB.mint)
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(
        priceLimit,
        poolInfo.mintA.decimals,
        poolInfo.mintB.decimals
      );
    }

    const isInputMintA = poolInfo.mintA.mint.equals(outputMint)

    const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
    const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)

    const ownerTokenAccountA = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintA.programId,
      mint: poolInfo.mintA.mint,
      tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintAUseSOLBalance || !isInputMintA ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: isInputMintA ? amountInMax : 0,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })
    const ownerTokenAccountB = await this._selectOrCreateTokenAccount({
      programId: poolInfo.mintB.programId,
      mint: poolInfo.mintB.mint,
      tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: mintBUseSOLBalance || isInputMintA ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: isInputMintA ? 0 : amountInMax,

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      !!ownerTokenAccountA || !!ownerTokenAccountB,
      "cannot found target token accounts",
      "tokenAccounts",
      ownerInfo.tokenAccounts,
    );

    const makeSwapBaseOutInstructions = this.makeSwapBaseOutInstructions({
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccountA: ownerTokenAccountA,
        tokenAccountB: ownerTokenAccountB
      },

      outputMint,

      amountOut,
      amountInMax,
      sqrtPriceLimitX64,

      remainingAccounts,
    })

    return {
      address: makeSwapBaseOutInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeSwapBaseOutInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeSwapBaseOutInstructions.innerTransaction.signers],
          lookupTableAddress: makeSwapBaseOutInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeSwapBaseOutInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeSwapBaseOutInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static makeCLosePositionInstructionSimple({
    poolInfo, ownerPosition, ownerInfo
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,

    ownerInfo: {
      wallet: PublicKey,
    },
  }) {
    const data = this.makeClosePositionInstructions({ poolInfo, ownerInfo, ownerPosition })
    return {
      address: data.address,
      innerTransactions: [data.innerTransaction]
    }
  }

  static async makeInitRewardInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardInfo,
    chainTime,
    associatedOnly = true,
    checkCreateATAOwner = false,
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardInfo: {
      programId: PublicKey,
      mint: PublicKey,
      openTime: number,
      endTime: number,
      perSecond: Decimal,
    }
    chainTime: number,
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
  }) {
    logger.assertArgument(
      rewardInfo.endTime > rewardInfo.openTime,
      "reward time error",
      "rewardInfo",
      rewardInfo,
    );
    logger.assertArgument(
      rewardInfo.openTime > chainTime,
      "reward must be paid later",
      "rewardInfo",
      rewardInfo,
    );

    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardInfo.mint.equals(Token.WSOL.mint)

    const _baseRewardAmount = rewardInfo.perSecond.mul(rewardInfo.endTime - rewardInfo.openTime)
    const ownerRewardAccount = await this._selectOrCreateTokenAccount({
      programId: rewardInfo.programId,
      mint: rewardInfo.mint,
      tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: rewardMintUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: new BN(new Decimal(_baseRewardAmount.toFixed(0)).gte(_baseRewardAmount) ? _baseRewardAmount.toFixed(0) : _baseRewardAmount.add(1).toFixed(0)),

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      ownerRewardAccount,
      "no money",
      "ownerRewardAccount",
      ownerInfo.tokenAccounts,
    );

    const makeInitRewardInstructions = this.makeInitRewardInstructions({
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccount: ownerRewardAccount
      },
      rewardInfo: {
        programId: rewardInfo.programId,
        mint: rewardInfo.mint,
        openTime: rewardInfo.openTime,
        endTime: rewardInfo.endTime,
        emissionsPerSecondX64: MathUtil.decimalToX64(rewardInfo.perSecond)
      }
    })

    return {
      address: makeInitRewardInstructions.address,
      innerTransactions: [
        {
          instructions: [...frontInstructions, ...makeInitRewardInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeInitRewardInstructions.innerTransaction.signers],
          lookupTableAddress: makeInitRewardInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...frontInstructionsType, ...makeInitRewardInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeInitRewardInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeInitRewardsInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardInfos,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardInfos: {
      programId: PublicKey,
      mint: PublicKey,
      openTime: number,
      endTime: number,
      perSecond: Decimal,
    }[],
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    for (const rewardInfo of rewardInfos) logger.assertArgument(rewardInfo.endTime > rewardInfo.openTime, "reward time error", "rewardInfo", rewardInfo,);
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];
    const makeInitRewardInstructions: MakeInstructionOutType[] = []

    const signers: Signer[] = []

    for (const rewardInfo of rewardInfos) {
      const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardInfo.mint.equals(Token.WSOL.mint)

      const _baseRewardAmount = rewardInfo.perSecond.mul(rewardInfo.endTime - rewardInfo.openTime)
      const ownerRewardAccount = await this._selectOrCreateTokenAccount({
        programId: rewardInfo.programId,
        mint: rewardInfo.mint,
        tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,
        createInfo: rewardMintUseSOLBalance ? {
          connection,
          payer: ownerInfo.feePayer,
          amount: new BN(new Decimal(_baseRewardAmount.toFixed(0)).gte(_baseRewardAmount) ? _baseRewardAmount.toFixed(0) : _baseRewardAmount.add(1).toFixed(0)),

          frontInstructions,
          endInstructions,
          frontInstructionsType,
          endInstructionsType,
          signers
        } : undefined,

        associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })

      logger.assertArgument(
        ownerRewardAccount,
        "no money",
        "ownerRewardAccount",
        ownerInfo.tokenAccounts,
      );

      makeInitRewardInstructions.push(this.makeInitRewardInstructions({
        poolInfo,
        ownerInfo: {
          wallet: ownerInfo.wallet,
          tokenAccount: ownerRewardAccount
        },
        rewardInfo: {
          programId: rewardInfo.programId,
          mint: rewardInfo.mint,
          openTime: rewardInfo.openTime,
          endTime: rewardInfo.endTime,
          emissionsPerSecondX64: MathUtil.decimalToX64(rewardInfo.perSecond)
        }
      }))
    }

    let address = {}
    for (const item of makeInitRewardInstructions) {
      address = { ...address, ...item.address }
    }

    return {
      address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeInitRewardInstructions.map(i => i.innerTransaction.instructions).flat(), ...endInstructions],
          signers: [...signers, ...makeInitRewardInstructions.map(i => i.innerTransaction.signers).flat()],
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeInitRewardInstructions.map(i => i.innerTransaction.instructionTypes).flat(), ...endInstructionsType],
          supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
          lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
        }
      ]
    }
  }

  static async makeSetRewardInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardInfo,
    chainTime,
    associatedOnly = true,
    checkCreateATAOwner = false,
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardInfo: {
      programId: PublicKey,
      mint: PublicKey,
      openTime: number, // If the reward is being distributed, please give 0
      endTime: number, // If no modification is required, enter 0
      perSecond: Decimal,
    },
    chainTime: number
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
  }) {
    logger.assertArgument(
      rewardInfo.endTime > rewardInfo.openTime,
      "reward time error",
      "rewardInfo",
      rewardInfo,
    );
    logger.assertArgument(
      rewardInfo.openTime > chainTime,
      "reward must be paid later",
      "rewardInfo",
      rewardInfo,
    );

    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardInfo.mint.equals(Token.WSOL.mint)
    const ownerRewardAccount = await this._selectOrCreateTokenAccount({
      programId: rewardInfo.programId,
      mint: rewardInfo.mint,
      tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: rewardMintUseSOLBalance ? {
        connection,
        payer: ownerInfo.feePayer,
        amount: new BN(new Decimal(rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).toFixed(0)).gte(rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime)) ? rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).toFixed(0) : rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).add(1).toFixed(0)),

        frontInstructions,
        endInstructions,
        frontInstructionsType,
        endInstructionsType,
        signers
      } : undefined,

      associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner
    })

    logger.assertArgument(
      ownerRewardAccount,
      "no money",
      "ownerRewardAccount",
      ownerInfo.tokenAccounts,
    );

    const makeSetRewardInstructions = this.makeSetRewardInstructions({
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccount: ownerRewardAccount
      },
      rewardInfo: {
        mint: rewardInfo.mint,
        openTime: rewardInfo.openTime,
        endTime: rewardInfo.endTime,
        emissionsPerSecondX64: MathUtil.decimalToX64(rewardInfo.perSecond)
      }
    })

    return {
      address: makeSetRewardInstructions.address,
      innerTransactions: [
        {
          instructions: [...frontInstructions, ...makeSetRewardInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeSetRewardInstructions.innerTransaction.signers],
          lookupTableAddress: makeSetRewardInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...frontInstructionsType, ...makeSetRewardInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeSetRewardInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeSetRewardsInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardInfos,
    chainTime,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardInfos: {
      programId: PublicKey,
      mint: PublicKey,
      openTime: number, // If the reward is being distributed, please give 0
      endTime: number, // If no modification is required, enter 0
      perSecond: Decimal,
    }[],
    chainTime: number
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const makeSetRewardInstructions: MakeInstructionOutType[] = [];

    const signers: Signer[] = []

    for (const rewardInfo of rewardInfos) {
      logger.assertArgument(
        rewardInfo.endTime > rewardInfo.openTime,
        "reward time error",
        "rewardInfo",
        rewardInfo,
      );
      logger.assertArgument(
        rewardInfo.openTime > chainTime,
        "reward must be paid later",
        "rewardInfo",
        rewardInfo,
      );

      const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardInfo.mint.equals(Token.WSOL.mint)
      const ownerRewardAccount = await this._selectOrCreateTokenAccount({
        programId: rewardInfo.programId,
        mint: rewardInfo.mint,
        tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,

        createInfo: rewardMintUseSOLBalance ? {
          connection,
          payer: ownerInfo.feePayer,
          amount: new BN(new Decimal(rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).toFixed(0)).gte(rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime)) ? rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).toFixed(0) : rewardInfo.perSecond.sub(rewardInfo.endTime - rewardInfo.openTime).add(1).toFixed(0)),

          frontInstructions,
          endInstructions,
          frontInstructionsType,
          endInstructionsType,
          signers
        } : undefined,

        associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })

      logger.assertArgument(
        ownerRewardAccount,
        "no money",
        "ownerRewardAccount",
        ownerInfo.tokenAccounts,
      );

      makeSetRewardInstructions.push(this.makeSetRewardInstructions({
        poolInfo,
        ownerInfo: {
          wallet: ownerInfo.wallet,
          tokenAccount: ownerRewardAccount
        },
        rewardInfo: {
          mint: rewardInfo.mint,
          openTime: rewardInfo.openTime,
          endTime: rewardInfo.endTime,
          emissionsPerSecondX64: MathUtil.decimalToX64(rewardInfo.perSecond)
        }
      }))
    }

    let address = {}
    for (const item of makeSetRewardInstructions) {
      address = { ...address, ...item.address }
    }

    return {
      address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeSetRewardInstructions.map(i => i.innerTransaction.instructions).flat(), ...endInstructions],
          signers: [...signers, ...makeSetRewardInstructions.map(i => i.innerTransaction.signers).flat()],
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeSetRewardInstructions.map(i => i.innerTransaction.instructionTypes).flat(), ...endInstructionsType],
          supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
          lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
        }
      ]
    }
  }

  static async makeCollectRewardInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardMint,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardMint: PublicKey,
    associatedOnly: boolean
    checkCreateATAOwner: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];

    const signers: Signer[] = []

    const rewardInfo = poolInfo.rewardInfos.find(i => i.tokenMint.equals(rewardMint))
    
    logger.assertArgument(
      rewardInfo !== undefined,
      "reward mint error",
      "not found reward mint",
      rewardMint,
    );
    if (rewardInfo === undefined) throw Error("reward mint error")

    const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardMint.equals(Token.WSOL.mint)
    const ownerRewardAccount = await this._selectOrCreateTokenAccount({
      programId: rewardInfo.tokenProgramId,
      mint: rewardMint,
      tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
      owner: ownerInfo.wallet,

      createInfo: {
        connection,
        payer: ownerInfo.feePayer,
        amount: 0,

        frontInstructions,
        endInstructions: rewardMintUseSOLBalance ? endInstructions : [],
        frontInstructionsType,
        endInstructionsType,
        signers
      },

      associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
      checkCreateATAOwner,
    })

    logger.assertArgument(
      ownerRewardAccount,
      "no money",
      "ownerRewardAccount",
      ownerInfo.tokenAccounts,
    );

    const makeCollectRewardInstructions = this.makeCollectRewardInstructions({
      poolInfo,
      ownerInfo: {
        wallet: ownerInfo.wallet,
        tokenAccount: ownerRewardAccount
      },

      rewardMint
    })

    return {
      address: makeCollectRewardInstructions.address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeCollectRewardInstructions.innerTransaction.instructions, ...endInstructions],
          signers: [...signers, ...makeCollectRewardInstructions.innerTransaction.signers],
          lookupTableAddress: makeCollectRewardInstructions.innerTransaction.lookupTableAddress,
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeCollectRewardInstructions.innerTransaction.instructionTypes, ...endInstructionsType],
          supportedVersion: makeCollectRewardInstructions.innerTransaction.supportedVersion
        }
      ]
    }
  }

  static async makeCollectRewardsInstructionSimple({
    connection,
    poolInfo,
    ownerInfo,
    rewardMints,
    associatedOnly = true,
    checkCreateATAOwner = false,
    computeBudgetConfig
  }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },

    rewardMints: PublicKey[],
    associatedOnly: boolean
    checkCreateATAOwner: boolean
    computeBudgetConfig?: ComputeBudgetConfig
  }) {
    const { instructions, instructionTypes } = computeBudgetConfig ? addComputeBudget(computeBudgetConfig).innerTransaction : { instructions: [], instructionTypes: [] }
    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];
    const makeCollectRewardInstructions: MakeInstructionOutType[] = []

    const signers: Signer[] = []

    for (const rewardMint of rewardMints) {
      const rewardInfo = poolInfo.rewardInfos.find(i => i.tokenMint.equals(rewardMint))
    
      logger.assertArgument(
        rewardInfo !== undefined,
        "reward mint error",
        "not found reward mint",
        rewardMint,
      );
      if (rewardInfo === undefined) throw Error("reward mint error")
      
      const rewardMintUseSOLBalance = ownerInfo.useSOLBalance && rewardMint.equals(Token.WSOL.mint)
      const ownerRewardAccount = await this._selectOrCreateTokenAccount({
        programId: rewardInfo.tokenProgramId,
        mint: rewardMint,
        tokenAccounts: rewardMintUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,

        createInfo: {
          connection,
          payer: ownerInfo.feePayer,
          amount: 0,

          frontInstructions,
          endInstructions: rewardMintUseSOLBalance ? endInstructions : [],
          signers,
          frontInstructionsType,
          endInstructionsType
        },

        associatedOnly: rewardMintUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })

      logger.assertArgument(
        ownerRewardAccount,
        "no money",
        "ownerRewardAccount",
        ownerInfo.tokenAccounts,
      );

      makeCollectRewardInstructions.push(this.makeCollectRewardInstructions({
        poolInfo,
        ownerInfo: {
          wallet: ownerInfo.wallet,
          tokenAccount: ownerRewardAccount
        },

        rewardMint
      }))
    }

    let address = {}
    for (const item of makeCollectRewardInstructions) {
      address = { ...address, ...item.address }
    }

    return {
      address,
      innerTransactions: [
        {
          instructions: [...instructions, ...frontInstructions, ...makeCollectRewardInstructions.map(i => i.innerTransaction.instructions).flat(), ...endInstructions],
          signers: [...signers, ...makeCollectRewardInstructions.map(i => i.innerTransaction.signers).flat()],
          instructionTypes: [...instructionTypes, ...frontInstructionsType, ...makeCollectRewardInstructions.map(i => i.innerTransaction.instructionTypes).flat(), ...endInstructionsType],
          supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
          lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
        }
      ]
    }
  }

  static async makeHarvestAllRewardInstructionSimple({
    connection, fetchPoolInfos, ownerInfo, associatedOnly = true, checkCreateATAOwner = false,
  }: {
    connection: Connection
    fetchPoolInfos: ReturnTypeFetchMultiplePoolInfos,
    ownerInfo: {
      feePayer: PublicKey,
      wallet: PublicKey,
      tokenAccounts: TokenAccount[],
      useSOLBalance?: boolean  // if has WSOL mint
    },
    associatedOnly?: boolean
    checkCreateATAOwner?: boolean
  }) {
    const ownerMintToAccount: { [mint: string]: PublicKey } = {}
    for (const item of ownerInfo.tokenAccounts) {
      if (associatedOnly) {
        const ata = getATAAddress(ownerInfo.wallet, item.accountInfo.mint, item.programId).publicKey
        if (ata.equals(item.pubkey)) ownerMintToAccount[item.accountInfo.mint.toString()] = item.pubkey
      } else {
        ownerMintToAccount[item.accountInfo.mint.toString()] = item.pubkey
      }
    }

    const frontInstructions: TransactionInstruction[] = [];
    const endInstructions: TransactionInstruction[] = [];
    const frontInstructionsType: InstructionType[] = [];
    const endInstructionsType: InstructionType[] = [];
    const makeDecreaseLiquidityInstructions: MakeInstructionOutType[] = [];

    const signers: Signer[] = []

    for (const itemInfo of Object.values(fetchPoolInfos)) {
      if (itemInfo.positionAccount === undefined) continue

      if (!itemInfo.positionAccount.find(i => !i.tokenFeeAmountA.isZero() || !i.tokenFeeAmountB.isZero() || i.rewardInfos.find(ii => !ii.pendingReward.isZero()))) continue

      const poolInfo = itemInfo.state

      const mintAUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintA.mint.equals(Token.WSOL.mint)
      const mintBUseSOLBalance = ownerInfo.useSOLBalance && poolInfo.mintB.mint.equals(Token.WSOL.mint)

      const ownerTokenAccountA = ownerMintToAccount[poolInfo.mintA.mint.toString()] ?? await this._selectOrCreateTokenAccount({
        programId: poolInfo.mintA.programId,
        mint: poolInfo.mintA.mint,
        tokenAccounts: mintAUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,

        createInfo: {
          connection,
          payer: ownerInfo.feePayer,
          amount: 0,

          frontInstructions,
          frontInstructionsType,
          endInstructions: mintAUseSOLBalance ? endInstructions : [],
          endInstructionsType: mintAUseSOLBalance ? endInstructionsType : [],
          signers
        },

        associatedOnly: mintAUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })

      const ownerTokenAccountB = ownerMintToAccount[poolInfo.mintB.mint.toString()] ?? await this._selectOrCreateTokenAccount({
        programId: poolInfo.mintB.programId,
        mint: poolInfo.mintB.mint,
        tokenAccounts: mintBUseSOLBalance ? [] : ownerInfo.tokenAccounts,
        owner: ownerInfo.wallet,

        createInfo: {
          connection,
          payer: ownerInfo.feePayer,
          amount: 0,

          frontInstructions,
          frontInstructionsType,
          endInstructions: mintBUseSOLBalance ? endInstructions : [],
          endInstructionsType: mintBUseSOLBalance ? endInstructionsType : [],
          signers
        },

        associatedOnly: mintBUseSOLBalance ? false : associatedOnly,
        checkCreateATAOwner,
      })
      ownerMintToAccount[poolInfo.mintA.mint.toString()] = ownerTokenAccountA
      ownerMintToAccount[poolInfo.mintB.mint.toString()] = ownerTokenAccountB

      const rewardAccounts: PublicKey[] = []
      for (const itemReward of poolInfo.rewardInfos) {
        const rewardUseSOLBalance = ownerInfo.useSOLBalance && itemReward.tokenMint.equals(Token.WSOL.mint)

        const ownerRewardAccount = ownerMintToAccount[itemReward.tokenMint.toString()] ?? await this._selectOrCreateTokenAccount({
          programId: itemReward.tokenProgramId,
          mint: itemReward.tokenMint,
          tokenAccounts: rewardUseSOLBalance ? [] : ownerInfo.tokenAccounts,
          owner: ownerInfo.wallet,

          createInfo: {
            connection,
            payer: ownerInfo.feePayer,
            amount: 0,

            frontInstructions,
            endInstructions: rewardUseSOLBalance ? endInstructions : [],
            frontInstructionsType,
            endInstructionsType,
            signers
          },

          associatedOnly: rewardUseSOLBalance ? false : associatedOnly,
          checkCreateATAOwner,
        })
        ownerMintToAccount[itemReward.tokenMint.toString()] = ownerRewardAccount
        rewardAccounts.push(ownerRewardAccount)
      }

      for (const itemPosition of itemInfo.positionAccount) {
        makeDecreaseLiquidityInstructions.push(this.makeDecreaseLiquidityInstructions({
          poolInfo,
          ownerPosition: itemPosition,
          ownerInfo: {
            wallet: ownerInfo.wallet,
            tokenAccountA: ownerTokenAccountA,
            tokenAccountB: ownerTokenAccountB,
            rewardAccounts
          },
          liquidity: ZERO,
          amountMinA: ZERO,
          amountMinB: ZERO
        }))
      }
    }

    const transactions = splitTxAndSigners({ instructions: makeDecreaseLiquidityInstructions.map(i => i.innerTransaction.instructions).flat(), signers: [], payer: ownerInfo.wallet })

    const innerTransactions = []
    if (frontInstructions.length > 0) innerTransactions.push({
      instructions: frontInstructions,
      signers,
      instructionTypes: frontInstructionsType,
      supportedVersion: [TxVersion.LEGACY, TxVersion.V0]
    })

    innerTransactions.push(...transactions.map(i => ({
      instructions: i.instruction,
      signers: i.signer as Signer[],
      instructionTypes: new Array(i.instruction.length).fill(InstructionType.clmmDecreasePosition),
      supportedVersion: [TxVersion.LEGACY, TxVersion.V0]
    })))

    if (endInstructions.length > 0) innerTransactions.push({
      instructions: endInstructions,
      signers: [],
      instructionTypes: endInstructionsType,
      supportedVersion: [TxVersion.LEGACY, TxVersion.V0]
    })


    return {
      address: {},
      innerTransactions
    }
  }

  // instrument
  static async makeCreatePoolInstructions({
    connection,
    programId,
    owner,
    mintA,
    mintB,
    ammConfigId,
    initialPriceX64,
    startTime,
  }: {
    connection: Connection,
    programId: PublicKey,
    owner: PublicKey,
    mintA: MintInfo,
    mintB: MintInfo,
    ammConfigId: PublicKey,
    initialPriceX64: BN,
    startTime: BN,
  }) {
    const observationId = new Keypair();

    const poolId = getPdaPoolId(programId, ammConfigId, mintA.mint, mintB.mint).publicKey;
    const mintAVault = getPdaPoolVaultId(programId, poolId, mintA.mint).publicKey;
    const mintBVault = getPdaPoolVaultId(programId, poolId, mintB.mint).publicKey;

    const instructions = [
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: observationId.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(ObservationInfoLayout.span),
        space: ObservationInfoLayout.span,
        programId,
      }),
      createPoolInstruction(
        programId,
        poolId,
        owner,
        ammConfigId,
        observationId.publicKey,
        mintA.mint,
        mintAVault,
        mintA.programId,
        mintB.mint,
        mintBVault,
        mintB.programId,
        initialPriceX64,
        startTime
      )
    ];

    return {
      address: {
        observationId: observationId.publicKey,
        poolId,
        mintAVault,
        mintBVault
      },
      innerTransaction: {
        instructions,
        signers: [observationId],
        instructionTypes: [InstructionType.createAccount, InstructionType.clmmCreatePool],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [],
      }
    }
  }

  static makeOpenPositionFromLiquidityInstructions(
    { poolInfo, ownerInfo, tickLower, tickUpper, liquidity, amountMaxA, amountMaxB, withMetadata }: {
      poolInfo: AmmV3PoolInfo,

      ownerInfo: {
        feePayer: PublicKey,
        wallet: PublicKey,
        tokenAccountA: PublicKey
        tokenAccountB: PublicKey
      },

      tickLower: number,
      tickUpper: number,
      liquidity: BN,
      amountMaxA: BN,
      amountMaxB: BN,

      withMetadata: 'create' | 'no-create',
    }
  ) {
    const nftMintAKeypair = new Keypair();

    const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(tickLower, poolInfo.ammConfig.tickSpacing);
    const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(tickUpper, poolInfo.ammConfig.tickSpacing);

    const { publicKey: tickArrayLower } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayLowerStartIndex);
    const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayUpperStartIndex);

    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, nftMintAKeypair.publicKey, TOKEN_PROGRAM_ID);
    const { publicKey: metadataAccount } = getPdaMetadataKey(nftMintAKeypair.publicKey);
    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, nftMintAKeypair.publicKey)
    const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(poolInfo.programId, poolInfo.id, tickLower, tickUpper)

    const ins = openPositionFromLiquidityInstruction(
      poolInfo.programId,
      ownerInfo.feePayer,
      poolInfo.id,
      ownerInfo.wallet,
      nftMintAKeypair.publicKey,
      positionNftAccount,
      metadataAccount,
      protocolPosition,
      tickArrayLower,
      tickArrayUpper,
      personalPosition,
      ownerInfo.tokenAccountA,
      ownerInfo.tokenAccountB,
      poolInfo.mintA.vault,
      poolInfo.mintB.vault,
      poolInfo.mintA.mint,
      poolInfo.mintB.mint,

      tickLower,
      tickUpper,
      tickArrayLowerStartIndex,
      tickArrayUpperStartIndex,
      liquidity,
      amountMaxA,
      amountMaxB,
      withMetadata,
    )

    return {
      address: {
        nftMint: nftMintAKeypair.publicKey,
        tickArrayLower,
        tickArrayUpper,
        positionNftAccount,
        metadataAccount,
        personalPosition,
        protocolPosition,
      },
      innerTransaction: {
        instructions: [ins],
        signers: [nftMintAKeypair],
        instructionTypes: [InstructionType.clmmOpenPosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeOpenPositionFromBaseInstructions(
    { poolInfo, ownerInfo, tickLower, tickUpper, base, baseAmount, otherAmountMax, withMetadata }: {
      poolInfo: AmmV3PoolInfo,

      ownerInfo: {
        feePayer: PublicKey,
        wallet: PublicKey,
        tokenAccountA: PublicKey
        tokenAccountB: PublicKey
      },

      tickLower: number,
      tickUpper: number,

      withMetadata: 'create' | 'no-create',

      base: 'MintA' | 'MintB',
      baseAmount: BN,

      otherAmountMax: BN,
    }
  ) {
    const nftMintAKeypair = new Keypair();

    const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(tickLower, poolInfo.ammConfig.tickSpacing);
    const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(tickUpper, poolInfo.ammConfig.tickSpacing);

    const { publicKey: tickArrayLower } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayLowerStartIndex);
    const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayUpperStartIndex);

    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, nftMintAKeypair.publicKey, TOKEN_PROGRAM_ID);
    const { publicKey: metadataAccount } = getPdaMetadataKey(nftMintAKeypair.publicKey);
    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, nftMintAKeypair.publicKey)
    const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(poolInfo.programId, poolInfo.id, tickLower, tickUpper)

    const ins = openPositionFromBaseInstruction(
      poolInfo.programId,
      ownerInfo.feePayer,
      poolInfo.id,
      ownerInfo.wallet,
      nftMintAKeypair.publicKey,
      positionNftAccount,
      metadataAccount,
      protocolPosition,
      tickArrayLower,
      tickArrayUpper,
      personalPosition,
      ownerInfo.tokenAccountA,
      ownerInfo.tokenAccountB,
      poolInfo.mintA.vault,
      poolInfo.mintB.vault,
      poolInfo.mintA.mint,
      poolInfo.mintB.mint,

      tickLower,
      tickUpper,
      tickArrayLowerStartIndex,
      tickArrayUpperStartIndex,

      withMetadata,

      base,
      baseAmount,
      
      otherAmountMax,
    )

    return {
      address: {
        nftMint: nftMintAKeypair.publicKey,
        tickArrayLower,
        tickArrayUpper,
        positionNftAccount,
        metadataAccount,
        personalPosition,
        protocolPosition,
      },
      innerTransaction: {
        instructions: [ins],
        signers: [nftMintAKeypair],
        instructionTypes: [InstructionType.clmmOpenPosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeIncreasePositionFromLiquidityInstructions({
    poolInfo,
    ownerPosition,
    ownerInfo,
    liquidity,
    amountMaxA,
    amountMaxB,
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,

    ownerInfo: {
      wallet: PublicKey,
      tokenAccountA: PublicKey
      tokenAccountB: PublicKey
    },

    liquidity: BN,
    amountMaxA: BN,
    amountMaxB: BN
  }) {
    const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickLower, poolInfo.ammConfig.tickSpacing);
    const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickUpper, poolInfo.ammConfig.tickSpacing);

    const { publicKey: tickArrayLower } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayLowerStartIndex);
    const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayUpperStartIndex);

    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, ownerPosition.nftMint, TOKEN_PROGRAM_ID);

    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, ownerPosition.nftMint);
    const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(poolInfo.programId, poolInfo.id, ownerPosition.tickLower, ownerPosition.tickUpper);

    return {
      address: {
        tickArrayLower,
        tickArrayUpper,
        positionNftAccount,
        personalPosition,
        protocolPosition,
      },
      innerTransaction: {
        instructions: [
          increasePositionFromLiquidityInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            positionNftAccount,
            personalPosition,
            poolInfo.id,
            protocolPosition,
            tickArrayLower,
            tickArrayUpper,
            ownerInfo.tokenAccountA,
            ownerInfo.tokenAccountB,
            poolInfo.mintA.vault,
            poolInfo.mintB.vault,
            poolInfo.mintA.mint,
            poolInfo.mintB.mint,

            liquidity,
            amountMaxA,
            amountMaxB
          )],
        signers: [],
        instructionTypes: [InstructionType.clmmIncreasePosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }


  static makeIncreasePositionFromBaseInstructions({
    poolInfo,
    ownerPosition,
    ownerInfo,
    base,
    baseAmount,
    otherAmountMax,
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,

    ownerInfo: {
      wallet: PublicKey,
      tokenAccountA: PublicKey
      tokenAccountB: PublicKey
    },

    base: 'MintA' | 'MintB',
    baseAmount: BN,

    otherAmountMax: BN,
  }) {
    const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickLower, poolInfo.ammConfig.tickSpacing);
    const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickUpper, poolInfo.ammConfig.tickSpacing);

    const { publicKey: tickArrayLower } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayLowerStartIndex);
    const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayUpperStartIndex);

    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, ownerPosition.nftMint, TOKEN_PROGRAM_ID);

    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, ownerPosition.nftMint);
    const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(poolInfo.programId, poolInfo.id, ownerPosition.tickLower, ownerPosition.tickUpper);

    return {
      address: {
        tickArrayLower,
        tickArrayUpper,
        positionNftAccount,
        personalPosition,
        protocolPosition,
      },
      innerTransaction: {
        instructions: [
          increasePositionFromBaseInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            positionNftAccount,
            personalPosition,
            poolInfo.id,
            protocolPosition,
            tickArrayLower,
            tickArrayUpper,
            ownerInfo.tokenAccountA,
            ownerInfo.tokenAccountB,
            poolInfo.mintA.vault,
            poolInfo.mintB.vault,
            poolInfo.mintA.mint,
            poolInfo.mintB.mint,

            base,
            baseAmount,

            otherAmountMax,
          )],
        signers: [],
        instructionTypes: [InstructionType.clmmIncreasePosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeDecreaseLiquidityInstructions({
    poolInfo,
    ownerPosition,
    ownerInfo,
    liquidity,
    amountMinA,
    amountMinB
  }: {

    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,

    ownerInfo: {
      wallet: PublicKey,
      tokenAccountA: PublicKey
      tokenAccountB: PublicKey
      rewardAccounts: PublicKey[]
    },

    liquidity: BN,
    amountMinA: BN,
    amountMinB: BN

  }) {
    const tickArrayLowerStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickLower, poolInfo.ammConfig.tickSpacing);
    const tickArrayUpperStartIndex = TickUtils.getTickArrayStartIndexByTick(ownerPosition.tickUpper, poolInfo.ammConfig.tickSpacing);

    const { publicKey: tickArrayLower } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayLowerStartIndex);
    const { publicKey: tickArrayUpper } = getPdaTickArrayAddress(poolInfo.programId, poolInfo.id, tickArrayUpperStartIndex);
    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, ownerPosition.nftMint, TOKEN_PROGRAM_ID);

    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, ownerPosition.nftMint);
    const { publicKey: protocolPosition } = getPdaProtocolPositionAddress(poolInfo.programId, poolInfo.id, ownerPosition.tickLower, ownerPosition.tickUpper);

    const rewardAccounts: { poolRewardVault: PublicKey, ownerRewardVault: PublicKey, rewardMint: PublicKey }[] = []
    for (let i = 0; i < poolInfo.rewardInfos.length; i++) {
      rewardAccounts.push({
        poolRewardVault: poolInfo.rewardInfos[i].tokenVault,
        ownerRewardVault: ownerInfo.rewardAccounts[i],
        rewardMint: poolInfo.rewardInfos[i].tokenMint,
      })
    }

    return {
      address: {
        tickArrayLower,
        tickArrayUpper,
        positionNftAccount,
        personalPosition,
        protocolPosition,
      },
      innerTransaction: {
        instructions: [
          decreaseLiquidityInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            positionNftAccount,
            personalPosition,
            poolInfo.id,
            protocolPosition,
            tickArrayLower,
            tickArrayUpper,
            ownerInfo.tokenAccountA,
            ownerInfo.tokenAccountB,
            poolInfo.mintA.vault,
            poolInfo.mintB.vault,
            poolInfo.mintA.mint,
            poolInfo.mintB.mint,
            rewardAccounts,

            liquidity,
            amountMinA,
            amountMinB
          )
        ],
        signers: [],
        instructionTypes: [InstructionType.clmmDecreasePosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeClosePositionInstructions({
    poolInfo, ownerInfo, ownerPosition
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerPosition: AmmV3PoolPersonalPosition,

    ownerInfo: {
      wallet: PublicKey,
    },
  }) {
    const { publicKey: positionNftAccount } = getATAAddress(ownerInfo.wallet, ownerPosition.nftMint, TOKEN_PROGRAM_ID);
    const { publicKey: personalPosition } = getPdaPersonalPositionAddress(poolInfo.programId, ownerPosition.nftMint)

    return {
      address: {
        positionNftAccount,
        personalPosition,
      },
      innerTransaction: {
        instructions: [
          closePositionInstruction(
            poolInfo.programId,

            ownerInfo.wallet,
            ownerPosition.nftMint,
            positionNftAccount,
            personalPosition
          )
        ],
        signers: [],
        instructionTypes: [InstructionType.clmmClosePosition],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      }
    }
  }

  static makeSwapBaseInInstructions({ poolInfo, ownerInfo, inputMint, amountIn, amountOutMin, sqrtPriceLimitX64, remainingAccounts }: {
    poolInfo: AmmV3PoolInfo,

    ownerInfo: {
      wallet: PublicKey,
      tokenAccountA: PublicKey
      tokenAccountB: PublicKey
    },

    inputMint: PublicKey

    amountIn: BN
    amountOutMin: BN
    sqrtPriceLimitX64: BN

    remainingAccounts: PublicKey[]
  }) {
    const isInputMintA = poolInfo.mintA.mint.equals(inputMint)

    return {
      address: {},
      innerTransaction: {
        instructions: [
          swapInstruction(
            poolInfo.programId,
            ownerInfo.wallet,

            poolInfo.id,
            poolInfo.ammConfig.id,

            isInputMintA ? ownerInfo.tokenAccountA : ownerInfo.tokenAccountB,
            isInputMintA ? ownerInfo.tokenAccountB : ownerInfo.tokenAccountA,

            isInputMintA ? poolInfo.mintA.vault : poolInfo.mintB.vault,
            isInputMintA ? poolInfo.mintB.vault : poolInfo.mintA.vault,

            isInputMintA ? poolInfo.mintA.mint : poolInfo.mintB.mint,
            isInputMintA ? poolInfo.mintB.mint : poolInfo.mintA.mint,

            remainingAccounts,
            poolInfo.observationId,
            amountIn,
            amountOutMin,
            sqrtPriceLimitX64,
            true
          )
        ],
        signers: [],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
        instructionTypes: [InstructionType.clmmSwapBaseIn],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0]
      }
    }
  }

  static makeSwapBaseOutInstructions({ poolInfo, ownerInfo, outputMint, amountOut, amountInMax, sqrtPriceLimitX64, remainingAccounts }: {
    poolInfo: AmmV3PoolInfo,

    ownerInfo: {
      wallet: PublicKey,
      tokenAccountA: PublicKey
      tokenAccountB: PublicKey
    },

    outputMint: PublicKey

    amountOut: BN
    amountInMax: BN
    sqrtPriceLimitX64: BN

    remainingAccounts: PublicKey[]
  }) {
    const isInputMintA = poolInfo.mintA.mint.equals(outputMint)

    return {
      address: {},
      innerTransaction: {
        instructions: [
          swapInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
    
            poolInfo.id,
            poolInfo.ammConfig.id,
    
            isInputMintA ? ownerInfo.tokenAccountB : ownerInfo.tokenAccountA,
            isInputMintA ? ownerInfo.tokenAccountA : ownerInfo.tokenAccountB,
    
            isInputMintA ? poolInfo.mintB.vault : poolInfo.mintA.vault,
            isInputMintA ? poolInfo.mintA.vault : poolInfo.mintB.vault,
    
            isInputMintA ? poolInfo.mintB.mint : poolInfo.mintA.mint,
            isInputMintA ? poolInfo.mintA.mint : poolInfo.mintB.mint,
    
            remainingAccounts,
            poolInfo.observationId,
            amountOut,
            amountInMax,
            sqrtPriceLimitX64,
            false
          ),
        ],
        signers: [],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
        instructionTypes: [InstructionType.clmmSwapBaseOut],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0]
      }
    }
  }

  static makeInitRewardInstructions({
    poolInfo, ownerInfo, rewardInfo
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      wallet: PublicKey,
      tokenAccount: PublicKey,
    },
    rewardInfo: {
      programId: PublicKey,
      mint: PublicKey,
      openTime: number,
      endTime: number,
      emissionsPerSecondX64: BN
    }
  }) {
    const poolRewardVault = getPdaPoolRewardVaulId(poolInfo.programId, poolInfo.id, rewardInfo.mint).publicKey
    const operationId = getPdaOperationAccount(poolInfo.programId).publicKey
    return {
      address: { poolRewardVault, operationId },
      innerTransaction: {
        instructions: [
          initRewardInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            poolInfo.id,
            operationId,
            poolInfo.ammConfig.id,

            ownerInfo.tokenAccount,
            rewardInfo.programId,
            rewardInfo.mint,
            poolRewardVault,

            rewardInfo.openTime,
            rewardInfo.endTime,
            rewardInfo.emissionsPerSecondX64
          ),
        ],
        signers: [],
        instructionTypes: [InstructionType.clmmInitReward],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeSetRewardInstructions({
    poolInfo, ownerInfo, rewardInfo
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      wallet: PublicKey,
      tokenAccount: PublicKey,
    },
    rewardInfo: {
      mint: PublicKey,
      openTime: number,
      endTime: number,
      emissionsPerSecondX64: BN
    }
  }) {
    let rewardIndex
    let rewardVault
    let rewardMint
    for (let index = 0; index < poolInfo.rewardInfos.length; index++)
      if (poolInfo.rewardInfos[index].tokenMint.equals(rewardInfo.mint)) {
        rewardIndex = index
        rewardVault = poolInfo.rewardInfos[index].tokenVault
        rewardMint = poolInfo.rewardInfos[index].tokenMint
      }

    if (rewardIndex === undefined || rewardVault === undefined || rewardMint === undefined) throw Error("reward mint check error")

    const operationId = getPdaOperationAccount(poolInfo.programId).publicKey

    return {
      address: { rewardVault, operationId },
      innerTransaction: {
        instructions: [
          setRewardInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            poolInfo.id,
            operationId,
            poolInfo.ammConfig.id,

            ownerInfo.tokenAccount,
            rewardVault,
            rewardMint,

            rewardIndex,
            rewardInfo.openTime,
            rewardInfo.endTime,
            rewardInfo.emissionsPerSecondX64
          )
        ],
        signers: [],
        instructionTypes: [InstructionType.clmmInitReward],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  static makeCollectRewardInstructions({
    poolInfo, ownerInfo, rewardMint
  }: {
    poolInfo: AmmV3PoolInfo,
    ownerInfo: {
      wallet: PublicKey,
      tokenAccount: PublicKey,
    },
    rewardMint: PublicKey
  }) {
    let rewardIndex
    let rewardVault
    for (let index = 0; index < poolInfo.rewardInfos.length; index++)
      if (poolInfo.rewardInfos[index].tokenMint.equals(rewardMint)) {
        rewardIndex = index
        rewardVault = poolInfo.rewardInfos[index].tokenVault
      }

    if (rewardIndex === undefined || rewardVault === undefined) throw Error("reward mint check error")

    return {
      address: { rewardVault },
      innerTransaction: {
        instructions: [
          collectRewardInstruction(
            poolInfo.programId,
            ownerInfo.wallet,
            poolInfo.id,

            ownerInfo.tokenAccount,
            rewardVault,
            rewardMint,

            rewardIndex,
          )
        ],
        signers: [],
        instructionTypes: [InstructionType.clmmInitReward],
        supportedVersion: [TxVersion.LEGACY, TxVersion.V0],
        lookupTableAddress: [poolInfo.lookupTableAccount].filter(i => !i.equals(PublicKey.default)),
      } as InnerTransaction
    }
  }

  // calculate
  static getLiquidityAmountOutFromAmountIn({ poolInfo, inputA, tickLower, tickUpper, amount, slippage, add, token2022Infos, epochInfo, amountHasFee }:
    { poolInfo: AmmV3PoolInfo, inputA: boolean, tickLower: number, tickUpper: number, amount: BN, slippage: number, add: boolean,
      amountHasFee: boolean,

      token2022Infos: ReturnTypeFetchMultipleMintInfos,
      epochInfo: EpochInfo,
     }): ReturnTypeGetLiquidityAmountOut {
    const sqrtPriceX64 = poolInfo.sqrtPriceX64
    const sqrtPriceX64A = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower)
    const sqrtPriceX64B = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper)

    const coefficient = add ? 1 - slippage : 1 + slippage;

    const addFeeAmount = getTransferAmountFee(amount, token2022Infos[inputA ? poolInfo.mintA.mint.toString() : poolInfo.mintB.mint.toString()]?.feeConfig, epochInfo, !amountHasFee)
    const _amount = addFeeAmount.amount.sub(addFeeAmount.fee ?? ZERO).muln(coefficient)

    let liquidity: BN
    if (sqrtPriceX64.lte(sqrtPriceX64A)) {
      liquidity = inputA ? LiquidityMath.getLiquidityFromTokenAmountA(sqrtPriceX64A, sqrtPriceX64B, _amount, !add) : new BN(0)
    } else if (sqrtPriceX64.lte(sqrtPriceX64B)) {
      const liquidity0 = LiquidityMath.getLiquidityFromTokenAmountA(sqrtPriceX64, sqrtPriceX64B, _amount, !add);
      const liquidity1 = LiquidityMath.getLiquidityFromTokenAmountB(sqrtPriceX64A, sqrtPriceX64, _amount);
      liquidity = inputA ? liquidity0 : liquidity1
    } else {
      liquidity = inputA ? new BN(0) : LiquidityMath.getLiquidityFromTokenAmountB(sqrtPriceX64A, sqrtPriceX64B, _amount);
    }

    return this.getAmountsFromLiquidity({ poolInfo, tickLower, tickUpper, liquidity, slippage, add, token2022Infos, epochInfo })
  }

  static getLiquidityFromAmounts({ poolInfo, tickLower, tickUpper, amountA, amountB, slippage, add, token2022Infos, epochInfo }:
    { poolInfo: AmmV3PoolInfo, tickLower: number, tickUpper: number, amountA: BN, amountB: BN, slippage: number, add: boolean,

      token2022Infos: ReturnTypeFetchMultipleMintInfos,
      epochInfo: EpochInfo,
    }): ReturnTypeGetLiquidityAmountOut {
    const [_tickLower, _tickUpper, _amountA, _amountB] = tickLower < tickUpper ? [tickLower, tickUpper, amountA, amountB] : [tickUpper, tickLower, amountB, amountA]
    const sqrtPriceX64 = poolInfo.sqrtPriceX64
    const sqrtPriceX64A = SqrtPriceMath.getSqrtPriceX64FromTick(_tickLower)
    const sqrtPriceX64B = SqrtPriceMath.getSqrtPriceX64FromTick(_tickUpper)

    const liquidity =  LiquidityMath.getLiquidityFromTokenAmounts(sqrtPriceX64, sqrtPriceX64A, sqrtPriceX64B, _amountA, _amountB)

    return this.getAmountsFromLiquidity({ poolInfo, tickLower, tickUpper, liquidity, slippage, add, token2022Infos, epochInfo })
  }

  
  static getAmountsFromLiquidity({ poolInfo, tickLower, tickUpper, liquidity, slippage, add, token2022Infos, epochInfo }: {
    poolInfo: AmmV3PoolInfo,
    tickLower: number,
    tickUpper: number,
    liquidity: BN
    slippage: number,
    add: boolean,

    token2022Infos: ReturnTypeFetchMultipleMintInfos,
    epochInfo: EpochInfo,
  }): ReturnTypeGetLiquidityAmountOut {
    const sqrtPriceX64A = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower)
    const sqrtPriceX64B = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper)

    const coefficientRe = add ? 1 + slippage : 1 - slippage;

    const amounts = LiquidityMath.getAmountsFromLiquidity(poolInfo.sqrtPriceX64, sqrtPriceX64A, sqrtPriceX64B, liquidity, add)
    const [amountA, amountB] = [
      getTransferAmountFee(amounts.amountA, token2022Infos[poolInfo.mintA.mint.toString()]?.feeConfig, epochInfo, true),
      getTransferAmountFee(amounts.amountB, token2022Infos[poolInfo.mintB.mint.toString()]?.feeConfig, epochInfo, true),
    ]
    const [amountSlippageA, amountSlippageB] = [
      getTransferAmountFee(amounts.amountA.muln(coefficientRe), token2022Infos[poolInfo.mintA.mint.toString()]?.feeConfig, epochInfo, true),
      getTransferAmountFee(amounts.amountB.muln(coefficientRe), token2022Infos[poolInfo.mintB.mint.toString()]?.feeConfig, epochInfo, true),
    ]

    return { liquidity, amountA, amountB, amountSlippageA, amountSlippageB, expirationTime: minExpirationTime(amountA.expirationTime, amountB.expirationTime) }
  }

  static getPriceAndTick({ poolInfo, price, baseIn }: { poolInfo: AmmV3PoolInfo, price: Decimal, baseIn: boolean }): ReturnTypeGetPriceAndTick {
    const _price = baseIn ? price : new Decimal(1).div(price)

    const tick = TickMath.getTickWithPriceAndTickspacing(_price, poolInfo.ammConfig.tickSpacing, poolInfo.mintA.decimals, poolInfo.mintB.decimals)
    const tickSqrtPriceX64 = SqrtPriceMath.getSqrtPriceX64FromTick(tick)
    const tickPrice = SqrtPriceMath.sqrtPriceX64ToPrice(tickSqrtPriceX64, poolInfo.mintA.decimals, poolInfo.mintB.decimals)

    return baseIn ? { tick, price: tickPrice } : { tick, price: new Decimal(1).div(tickPrice) }
  }

  static getTickPrice({ poolInfo, tick, baseIn }: { poolInfo: AmmV3PoolInfo, tick: number, baseIn: boolean }): ReturnTypeGetTickPrice {
    const tickSqrtPriceX64 = SqrtPriceMath.getSqrtPriceX64FromTick(tick)
    const tickPrice = SqrtPriceMath.sqrtPriceX64ToPrice(tickSqrtPriceX64, poolInfo.mintA.decimals, poolInfo.mintB.decimals)

    return baseIn ? { tick, price: tickPrice, tickSqrtPriceX64 } : { tick, price: new Decimal(1).div(tickPrice), tickSqrtPriceX64 }
  }

  static computeAmountOutFormat({ poolInfo, tickArrayCache, token2022Infos, epochInfo, amountIn, currencyOut, slippage }: {
    poolInfo: AmmV3PoolInfo,
    tickArrayCache: { [key: string]: TickArray; },

    token2022Infos: ReturnTypeFetchMultipleMintInfos,
    epochInfo: EpochInfo,

    amountIn: CurrencyAmount | TokenAmount,
    currencyOut: Token | Currency,
    slippage: Percent
  }): ReturnTypeComputeAmountOutFormat {
    const amountInIsTokenAmount = amountIn instanceof TokenAmount
    const inputMint = (amountInIsTokenAmount ? amountIn.token : Token.WSOL).mint;
    const _amountIn = amountIn.raw
    const _slippage = slippage.numerator.toNumber() / slippage.denominator.toNumber()

    const { realAmountIn: _realAmountIn, amountOut: _amountOut, minAmountOut: _minAmountOut, expirationTime, currentPrice, executionPrice, priceImpact, fee, remainingAccounts } = AmmV3.computeAmountOut({
      poolInfo,
      tickArrayCache,
      baseMint: inputMint,
      amountIn: _amountIn,
      slippage: _slippage,

      token2022Infos,
      epochInfo
    })

    const realAmountIn = { 
      ..._realAmountIn, 
      amount: amountInIsTokenAmount ? new TokenAmount(amountIn.token, _realAmountIn.amount) : new CurrencyAmount(Currency.SOL, _realAmountIn.amount),
      fee: _realAmountIn.fee === undefined ? undefined : amountInIsTokenAmount ? new TokenAmount(amountIn.token, _realAmountIn.fee) : new CurrencyAmount(Currency.SOL, _realAmountIn.fee)
    }

    const amountOut = { 
      ..._amountOut, 
      amount: currencyOut instanceof Token ? new TokenAmount(currencyOut, _amountOut.amount) : new CurrencyAmount(currencyOut, _amountOut.amount),
      fee: _amountOut.fee === undefined ? undefined : currencyOut instanceof Token ? new TokenAmount(currencyOut, _amountOut.fee) : new CurrencyAmount(currencyOut, _amountOut.fee)
    }
    const minAmountOut = { 
      ..._minAmountOut, 
      amount: currencyOut instanceof Token ? new TokenAmount(currencyOut, _minAmountOut.amount) : new CurrencyAmount(currencyOut, _minAmountOut.amount),
      fee: _minAmountOut.fee === undefined ? undefined : currencyOut instanceof Token ? new TokenAmount(currencyOut, _minAmountOut.fee) : new CurrencyAmount(currencyOut, _minAmountOut.fee)
    }
    const _currentPrice = new Price(
      amountInIsTokenAmount ? amountIn.token : amountIn.currency,
      new BN(10).pow(new BN(20 + (amountInIsTokenAmount ? amountIn.token : amountIn.currency).decimals)),
      currencyOut instanceof Token ? currencyOut : Token.WSOL,
      currentPrice.mul(new Decimal(10 ** (20 + (currencyOut instanceof Token ? currencyOut : Token.WSOL).decimals))).toFixed(0)
    )
    const _executionPrice = new Price(
      amountInIsTokenAmount ? amountIn.token : amountIn.currency,
      new BN(10).pow(new BN(20 + (amountInIsTokenAmount ? amountIn.token : amountIn.currency).decimals)),
      currencyOut instanceof Token ? currencyOut : Token.WSOL,
      executionPrice.mul(new Decimal(10 ** (20 + (currencyOut instanceof Token ? currencyOut : Token.WSOL).decimals))).toFixed(0)
    )
    const _fee = amountInIsTokenAmount ? new TokenAmount(amountIn.token, fee) : new CurrencyAmount(amountIn.currency, fee);

    return {
      realAmountIn,
      amountOut,
      minAmountOut,
      expirationTime,
      currentPrice: _currentPrice,
      executionPrice: _executionPrice,
      priceImpact,
      fee: _fee,
      remainingAccounts
    }
  }

  static async computeAmountOutAndCheckToken({ connection, poolInfo, tickArrayCache, baseMint, amountIn, slippage, priceLimit = new Decimal(0) }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    tickArrayCache: { [key: string]: TickArray; },
    baseMint: PublicKey,

    amountIn: BN,
    slippage: number,
    priceLimit?: Decimal
  }) {
    const epochInfo = await connection.getEpochInfo()
    const token2022Infos = await fetchMultipleMintInfos({ connection, mints: [ poolInfo.mintA, poolInfo.mintB ].filter(i => i.programId.equals(TOKEN_2022_PROGRAM_ID)).map(i => i.mint)})
    return this.computeAmountOut({
      poolInfo, tickArrayCache, baseMint, amountIn, slippage, priceLimit,
      token2022Infos, epochInfo
    })
  }

  static computeAmountOut(
    { poolInfo, tickArrayCache, baseMint, token2022Infos, epochInfo, amountIn, slippage, priceLimit = new Decimal(0) }: {
      poolInfo: AmmV3PoolInfo,
      tickArrayCache: { [key: string]: TickArray; },
      baseMint: PublicKey,

      token2022Infos: ReturnTypeFetchMultipleMintInfos,
      epochInfo: EpochInfo,

      amountIn: BN,
      slippage: number,
      priceLimit?: Decimal
    }
  ): ReturnTypeComputeAmountOut {
    let sqrtPriceLimitX64: BN;
    if (priceLimit.equals(new Decimal(0))) {
      sqrtPriceLimitX64 = baseMint.equals(poolInfo.mintA.mint)
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(
        priceLimit,
        poolInfo.mintA.decimals,
        poolInfo.mintB.decimals
      );
    }

    const realAmountIn = getTransferAmountFee(amountIn, token2022Infos[baseMint.toString()]?.feeConfig, epochInfo, false)

    const { expectedAmountOut: _expectedAmountOut, remainingAccounts, executionPrice: _executionPriceX64, feeAmount } = PoolUtils.getOutputAmountAndRemainAccounts(
      poolInfo,
      tickArrayCache,
      baseMint,
      realAmountIn.amount.sub(realAmountIn.fee ?? ZERO),
      sqrtPriceLimitX64
    );

    const outMint = poolInfo.mintA.mint.equals(baseMint) ? poolInfo.mintB.mint : poolInfo.mintA.mint
    const amountOut = getTransferAmountFee(_expectedAmountOut, token2022Infos[outMint.toString()]?.feeConfig, epochInfo, false)

    const _executionPrice = SqrtPriceMath.sqrtPriceX64ToPrice(_executionPriceX64, poolInfo.mintA.decimals, poolInfo.mintB.decimals)
    const executionPrice = baseMint.equals(poolInfo.mintA.mint) ? _executionPrice : new Decimal(1).div(_executionPrice)

    const _minAmountOut = _expectedAmountOut.mul(new BN(Math.floor((1 - slippage) * 10000000000))).div(new BN(10000000000));
    const minAmountOut = getTransferAmountFee(_minAmountOut, token2022Infos[outMint.toString()]?.feeConfig, epochInfo, false)

    const poolPrice = poolInfo.mintA.mint.equals(baseMint) ? poolInfo.currentPrice : new Decimal(1).div(poolInfo.currentPrice)

    const _numerator = new Decimal(executionPrice).sub(poolPrice).abs()
    const _denominator = poolPrice
    const priceImpact = new Percent(
      new Decimal(_numerator).mul(10 ** 15).toFixed(0),
      new Decimal(_denominator).mul(10 ** 15).toFixed(0),
    );

    return {
      realAmountIn,
      amountOut,
      minAmountOut,
      expirationTime: minExpirationTime(realAmountIn.expirationTime, amountOut.expirationTime),
      currentPrice: poolInfo.currentPrice,
      executionPrice,
      priceImpact,
      fee: feeAmount,

      remainingAccounts
    }
  }

  static async computeAmountInAndCheckToken({ connection, poolInfo, tickArrayCache, baseMint, amountOut, slippage, priceLimit = new Decimal(0) }: {
    connection: Connection
    poolInfo: AmmV3PoolInfo,
    tickArrayCache: { [key: string]: TickArray; },
    baseMint: PublicKey,

    amountOut: BN,
    slippage: number,
    priceLimit?: Decimal
  }) {
    const epochInfo = await connection.getEpochInfo()
    const token2022Infos = await fetchMultipleMintInfos({ connection, mints: [ poolInfo.mintA, poolInfo.mintB ].filter(i => i.programId.equals(TOKEN_2022_PROGRAM_ID)).map(i => i.mint)})
    return this.computeAmountIn({
      poolInfo, tickArrayCache, baseMint, amountOut, slippage, priceLimit,
      token2022Infos, epochInfo
    })
  }

  static computeAmountIn(
    { poolInfo, tickArrayCache, baseMint, token2022Infos, epochInfo, amountOut, slippage, priceLimit = new Decimal(0) }: {
      poolInfo: AmmV3PoolInfo,
      tickArrayCache: { [key: string]: TickArray; },
      baseMint: PublicKey,

      token2022Infos: ReturnTypeFetchMultipleMintInfos,
      epochInfo: EpochInfo,

      amountOut: BN,
      slippage: number,
      priceLimit?: Decimal
    }
  ): ReturnTypeComputeAmountOutBaseOut {
    let sqrtPriceLimitX64: BN;
    if (priceLimit.equals(new Decimal(0))) {
      sqrtPriceLimitX64 = baseMint.equals(poolInfo.mintB.mint)
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
    } else {
      sqrtPriceLimitX64 = SqrtPriceMath.priceToSqrtPriceX64(
        priceLimit,
        poolInfo.mintA.decimals,
        poolInfo.mintB.decimals
      );
    }

    const realAmountOut = getTransferAmountFee(amountOut, token2022Infos[baseMint.toString()]?.feeConfig, epochInfo, true)

    const { expectedAmountIn: _expectedAmountIn, remainingAccounts, executionPrice: _executionPriceX64, feeAmount } = PoolUtils.getInputAmountAndRemainAccounts(
      poolInfo,
      tickArrayCache,
      baseMint,
      realAmountOut.amount.sub(realAmountOut.fee ?? ZERO),
      sqrtPriceLimitX64
    );

    const inMint = poolInfo.mintA.mint.equals(baseMint) ? poolInfo.mintB.mint : poolInfo.mintA.mint
    const amountIn = getTransferAmountFee(_expectedAmountIn, token2022Infos[inMint.toString()]?.feeConfig, epochInfo, true)

    const _executionPrice = SqrtPriceMath.sqrtPriceX64ToPrice(_executionPriceX64, poolInfo.mintA.decimals, poolInfo.mintB.decimals)
    const executionPrice = baseMint.equals(poolInfo.mintA.mint) ? _executionPrice : new Decimal(1).div(_executionPrice)

    const _maxAmountIn = _expectedAmountIn.mul(new BN(Math.floor((1 + slippage) * 10000000000))).div(new BN(10000000000));
    const maxAmountIn = getTransferAmountFee(_maxAmountIn, token2022Infos[inMint.toString()]?.feeConfig, epochInfo, true)

    const poolPrice = poolInfo.mintA.mint.equals(baseMint) ? poolInfo.currentPrice : new Decimal(1).div(poolInfo.currentPrice)

    const _numerator = new Decimal(executionPrice).sub(poolPrice).abs()
    const _denominator = poolPrice
    const priceImpact = new Percent(
      new Decimal(_numerator).mul(10 ** 15).toFixed(0),
      new Decimal(_denominator).mul(10 ** 15).toFixed(0),
    );

    return {
      amountIn,
      maxAmountIn,
      realAmountOut,
      expirationTime: minExpirationTime(amountIn.expirationTime, realAmountOut.expirationTime),
      currentPrice: poolInfo.currentPrice,
      executionPrice,
      priceImpact,
      fee: feeAmount,

      remainingAccounts
    }
  }

  static estimateAprsForPriceRangeMultiplier({ poolInfo, aprType, positionTickLowerIndex, positionTickUpperIndex }: {
    poolInfo: AmmV3PoolInfo,
    aprType: 'day' | 'week' | 'month',

    positionTickLowerIndex: number,
    positionTickUpperIndex: number,
  }) {
    const aprInfo = poolInfo[aprType]

    const priceLower = this.getTickPrice({ poolInfo, tick: positionTickLowerIndex, baseIn: true }).price.toNumber()
    const priceUpper = this.getTickPrice({ poolInfo, tick: positionTickUpperIndex, baseIn: true }).price.toNumber()

    const _minPrice = Math.max(priceLower, aprInfo.priceMin)
    const _maxPrice = Math.min(priceUpper, aprInfo.priceMax)

    const sub = _maxPrice - _minPrice

    const userRange = priceUpper - priceLower
    const tradeRange = aprInfo.priceMax - aprInfo.priceMin

    let p

    if (sub <= 0) p = 0
    else if (userRange === sub) p = (tradeRange) / sub
    else if (tradeRange === sub) p = sub / (userRange)
    else p = sub / (tradeRange) * (sub / (userRange))

    return {
      feeApr: aprInfo.feeApr * p,
      rewardsApr: [aprInfo.rewardApr.A * p, aprInfo.rewardApr.B * p, aprInfo.rewardApr.C * p],
      apr: aprInfo.apr * p
    }
  }

  static estimateAprsForPriceRangeDelta({ poolInfo, aprType, mintPrice, rewardMintDecimals, liquidity, positionTickLowerIndex, positionTickUpperIndex, chainTime }: {
    poolInfo: AmmV3PoolInfo,
    aprType: 'day' | 'week' | 'month',

    mintPrice: { [mint: string]: Price },

    rewardMintDecimals: { [mint: string]: number },

    liquidity: BN,
    positionTickLowerIndex: number,
    positionTickUpperIndex: number,

    chainTime: number,
  }) {
    const aprTypeDay = aprType === 'day' ? 1 : aprType === 'week' ? 7 : aprType === 'month' ? 30 : 0
    const aprInfo = poolInfo[aprType]
    const mintPriceA = mintPrice[poolInfo.mintA.mint.toString()]
    const mintPriceB = mintPrice[poolInfo.mintB.mint.toString()]
    const mintDecimalsA = poolInfo.mintA.decimals
    const mintDecimalsB = poolInfo.mintB.decimals

    if (!aprInfo || !mintPriceA || !mintPriceB) return { feeApr: 0, rewardsApr: [0, 0, 0], apr: 0 }

    const sqrtPriceX64A = SqrtPriceMath.getSqrtPriceX64FromTick(positionTickLowerIndex)
    const sqrtPriceX64B = SqrtPriceMath.getSqrtPriceX64FromTick(positionTickUpperIndex)

    const { amountSlippageA: poolLiquidityA, amountSlippageB: poolLiquidityB } = LiquidityMath.getAmountsFromLiquidityWithSlippage(poolInfo.sqrtPriceX64, sqrtPriceX64A, sqrtPriceX64B, poolInfo.liquidity, false, false, 0)
    const { amountSlippageA: userLiquidityA, amountSlippageB: userLiquidityB } = LiquidityMath.getAmountsFromLiquidityWithSlippage(poolInfo.sqrtPriceX64, sqrtPriceX64A, sqrtPriceX64B, liquidity, false, false, 0)

    const poolTvl = new Decimal(poolLiquidityA.toString()).div(new Decimal(10).pow(mintDecimalsA)).mul(mintPriceA.toFixed(mintDecimalsA)).add(new Decimal(poolLiquidityB.toString()).div(new Decimal(10).pow(mintDecimalsB)).mul(mintPriceB.toFixed(mintDecimalsB)))
    const userTvl = new Decimal(userLiquidityA.toString()).div(new Decimal(10).pow(mintDecimalsA)).mul(mintPriceA.toFixed(mintDecimalsA)).add(new Decimal(userLiquidityB.toString()).div(new Decimal(10).pow(mintDecimalsB)).mul(mintPriceB.toFixed(mintDecimalsB)))

    const p = userTvl.div(poolTvl.add(userTvl)).div(userTvl)

    const feesPerYear = new Decimal(aprInfo.volumeFee).mul(365).div(aprTypeDay);
    const feeApr = feesPerYear.mul(p).mul(100).toNumber();

    const SECONDS_PER_YEAR = 3600 * 24 * 365

    const rewardsApr = poolInfo.rewardInfos.map((i) => {
      const iDecimal = rewardMintDecimals[i.tokenMint.toString()]
      const iPrice = mintPrice[i.tokenMint.toString()]

      if (chainTime < i.openTime.toNumber() || chainTime > i.endTime.toNumber() || i.perSecond.equals(0) || !iPrice || iDecimal === undefined) return 0

      return new Decimal(iPrice.toFixed(iDecimal)).mul(i.perSecond.mul(SECONDS_PER_YEAR)).div(new Decimal(10).pow(iDecimal)).mul(p).mul(100).toNumber()
    })

    return {
      feeApr,
      rewardsApr,
      apr: feeApr + rewardsApr.reduce((a, b) => a + b, 0)
    }
  }

  // fetch data
  static async fetchMultiplePoolInfos({ connection, poolKeys, ownerInfo, chainTime, batchRequest = false, updateOwnerRewardAndFee = true }: { connection: Connection, poolKeys: ApiAmmV3PoolsItem[], ownerInfo?: { wallet: PublicKey, tokenAccounts: TokenAccount[] }, chainTime: number, batchRequest?: boolean, updateOwnerRewardAndFee?: boolean }): Promise<ReturnTypeFetchMultiplePoolInfos> {
    const poolAccountInfos = await getMultipleAccountsInfo(connection, poolKeys.map(i => new PublicKey(i.id)), { batchRequest })

    const programIds: PublicKey[] = []

    const poolsInfo: ReturnTypeFetchMultiplePoolInfos = {}

    const updateRewardInfos: AmmV3PoolRewardInfo[] = []

    for (let index = 0; index < poolKeys.length; index++) {
      const apiPoolInfo = poolKeys[index]
      const accountInfo = poolAccountInfos[index]

      if (accountInfo === null) continue

      const layoutAccountInfo = PoolInfoLayout.decode(accountInfo.data)

      poolsInfo[apiPoolInfo.id] = {
        state: {
          id: new PublicKey(apiPoolInfo.id),
          mintA: {
            programId: new PublicKey(apiPoolInfo.mintProgramIdA),
            mint: layoutAccountInfo.mintA,
            vault: layoutAccountInfo.vaultA,
            decimals: layoutAccountInfo.mintDecimalsA,
          },
          mintB: {
            programId: new PublicKey(apiPoolInfo.mintProgramIdB),
            mint: layoutAccountInfo.mintB,
            vault: layoutAccountInfo.vaultB,
            decimals: layoutAccountInfo.mintDecimalsB,
          },
          observationId: layoutAccountInfo.observationId,
          ammConfig: {
            ...apiPoolInfo.ammConfig,
            id: new PublicKey(apiPoolInfo.ammConfig.id)
          },

          creator: layoutAccountInfo.creator,
          programId: accountInfo.owner,
          version: 6,

          tickSpacing: layoutAccountInfo.tickSpacing,
          liquidity: layoutAccountInfo.liquidity,
          sqrtPriceX64: layoutAccountInfo.sqrtPriceX64,
          currentPrice: SqrtPriceMath.sqrtPriceX64ToPrice(layoutAccountInfo.sqrtPriceX64, layoutAccountInfo.mintDecimalsA, layoutAccountInfo.mintDecimalsB),
          tickCurrent: layoutAccountInfo.tickCurrent,
          observationIndex: layoutAccountInfo.observationIndex,
          observationUpdateDuration: layoutAccountInfo.observationUpdateDuration,
          feeGrowthGlobalX64A: layoutAccountInfo.feeGrowthGlobalX64A,
          feeGrowthGlobalX64B: layoutAccountInfo.feeGrowthGlobalX64B,
          protocolFeesTokenA: layoutAccountInfo.protocolFeesTokenA,
          protocolFeesTokenB: layoutAccountInfo.protocolFeesTokenB,
          swapInAmountTokenA: layoutAccountInfo.swapInAmountTokenA,
          swapOutAmountTokenB: layoutAccountInfo.swapOutAmountTokenB,
          swapInAmountTokenB: layoutAccountInfo.swapInAmountTokenB,
          swapOutAmountTokenA: layoutAccountInfo.swapOutAmountTokenA,
          tickArrayBitmap: layoutAccountInfo.tickArrayBitmap,

          rewardInfos: await PoolUtils.updatePoolRewardInfos({
            connection,
            apiPoolInfo,
            chainTime,
            poolLiquidity: layoutAccountInfo.liquidity,
            rewardInfos: layoutAccountInfo.rewardInfos.filter(i => !i.tokenMint.equals(PublicKey.default))
          }),

          day: apiPoolInfo.day,
          week: apiPoolInfo.week,
          month: apiPoolInfo.month,
          tvl: apiPoolInfo.tvl,
          lookupTableAccount: new PublicKey(apiPoolInfo.lookupTableAccount),

          startTime: layoutAccountInfo.startTime.toNumber(),
        }
      }

      if (ownerInfo) {
        updateRewardInfos.push(...poolsInfo[apiPoolInfo.id].state.rewardInfos.filter(i => i.creator.equals(ownerInfo.wallet)))
      }

      if (!programIds.find(i => i.equals(accountInfo.owner))) programIds.push(accountInfo.owner)
    }

    if (ownerInfo) {
      const allMint = ownerInfo.tokenAccounts.filter(i => i.accountInfo.amount.eq(new BN(1))).map(i => i.accountInfo.mint)
      const allPositionKey: PublicKey[] = []
      for (const itemMint of allMint) {
        for (const itemProgramId of programIds) {
          allPositionKey.push(getPdaPersonalPositionAddress(itemProgramId, itemMint).publicKey)
        }
      }
      const positionAccountInfos = await getMultipleAccountsInfo(connection, allPositionKey, { batchRequest })

      const keyToTickArrayAddress: { [key: string]: PublicKey } = {}
      for (const itemAccountInfo of positionAccountInfos) {
        if (itemAccountInfo === null) continue
        const position = PositionInfoLayout.decode(itemAccountInfo.data)
        const itemPoolId = position.poolId.toString()
        const poolInfoA = poolsInfo[itemPoolId]
        if (poolInfoA === undefined) continue

        const poolInfo = poolInfoA.state

        const priceLower = this.getTickPrice({
          poolInfo,
          tick: position.tickLower,
          baseIn: true
        })
        const priceUpper = this.getTickPrice({
          poolInfo,
          tick: position.tickUpper,
          baseIn: true
        })
        const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(poolInfo.sqrtPriceX64, priceLower.tickSqrtPriceX64, priceUpper.tickSqrtPriceX64, position.liquidity, false)

        const leverage = 1 / (1 - Math.sqrt(Math.sqrt(priceLower.price.div(priceUpper.price).toNumber())))

        poolsInfo[itemPoolId].positionAccount = [...(poolsInfo[itemPoolId].positionAccount ?? []), {
          poolId: position.poolId,
          nftMint: position.nftMint,

          priceLower: priceLower.price,
          priceUpper: priceUpper.price,
          amountA,
          amountB,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: position.liquidity,
          feeGrowthInsideLastX64A: position.feeGrowthInsideLastX64A,
          feeGrowthInsideLastX64B: position.feeGrowthInsideLastX64B,
          tokenFeesOwedA: position.tokenFeesOwedA,
          tokenFeesOwedB: position.tokenFeesOwedB,
          rewardInfos: position.rewardInfos.map(i => ({
            ...i,
            pendingReward: new BN(0)
          })),

          leverage,
          tokenFeeAmountA: new BN(0),
          tokenFeeAmountB: new BN(0),
        }]

        const tickArrayLowerAddress = TickUtils.getTickArrayAddressByTick(
          poolsInfo[itemPoolId].state.programId,
          position.poolId,
          position.tickLower,
          poolsInfo[itemPoolId].state.tickSpacing
        );
        const tickArrayUpperAddress = TickUtils.getTickArrayAddressByTick(
          poolsInfo[itemPoolId].state.programId,
          position.poolId,
          position.tickUpper,
          poolsInfo[itemPoolId].state.tickSpacing
        );
        keyToTickArrayAddress[`${poolsInfo[itemPoolId].state.programId.toString()}-${position.poolId.toString()}-${position.tickLower}`] = tickArrayLowerAddress
        keyToTickArrayAddress[`${poolsInfo[itemPoolId].state.programId.toString()}-${position.poolId.toString()}-${position.tickUpper}`] = tickArrayUpperAddress
      }

      if (updateOwnerRewardAndFee) {
        const tickArrayKeys = Object.values(keyToTickArrayAddress)
        const tickArrayDatas = await getMultipleAccountsInfo(connection, tickArrayKeys, { batchRequest })
        const tickArrayLayout: {[key:string]: TickArray} = {}
        for (let index = 0; index < tickArrayKeys.length; index++) {
          const tickArrayData = tickArrayDatas[index]
          if (tickArrayData === null) continue
          const key = tickArrayKeys[index]
          tickArrayLayout[key.toString()] = {
            address: key,
            ...TickArrayLayout.decode(tickArrayData.data)
          }
        }
  
        for (const { state, positionAccount } of Object.values(poolsInfo)) {
          if (!positionAccount) continue
          for (const itemPA of positionAccount) {
            const keyLower = `${state.programId.toString()}-${state.id.toString()}-${itemPA.tickLower}`
            const keyUpper = `${state.programId.toString()}-${state.id.toString()}-${itemPA.tickUpper}`
            const tickArrayLower = tickArrayLayout[keyToTickArrayAddress[keyLower].toString()]
            const tickArrayUpper = tickArrayLayout[keyToTickArrayAddress[keyUpper].toString()]
            const tickLowerState: Tick = tickArrayLower.ticks[TickUtils.getTickOffsetInArray(
              itemPA.tickLower,
              state.tickSpacing
            )]
            const tickUpperState: Tick = tickArrayUpper.ticks[TickUtils.getTickOffsetInArray(
              itemPA.tickUpper,
              state.tickSpacing
            )]
            const { tokenFeeAmountA, tokenFeeAmountB } = PositionUtils.GetPositionFees(state, itemPA, tickLowerState, tickUpperState)
            const rewardInfos = PositionUtils.GetPositionRewards(state, itemPA, tickLowerState, tickUpperState)
            itemPA.tokenFeeAmountA = tokenFeeAmountA.gte(ZERO) ? tokenFeeAmountA : ZERO
            itemPA.tokenFeeAmountB = tokenFeeAmountB.gte(ZERO) ? tokenFeeAmountB : ZERO
            for (let i = 0; i < rewardInfos.length; i++) {
              itemPA.rewardInfos[i].pendingReward = rewardInfos[i].gte(ZERO) ? rewardInfos[i] : ZERO
            }
          }
        }
      }
    }

    if (updateRewardInfos.length > 0) {
      const vaults = updateRewardInfos.map(i => i.tokenVault)
      const rewardVaultInfos = await getMultipleAccountsInfo(connection, vaults, { batchRequest })
      const rewardVaultAmount: { [mint: string]: BN } = {}
      for (let index = 0; index < vaults.length; index++) {
        const valutKey = vaults[index].toString()
        const itemRewardVaultInfo = rewardVaultInfos[index]
        if (itemRewardVaultInfo === null) continue
        const info = SPL_ACCOUNT_LAYOUT.decode(itemRewardVaultInfo.data)
        rewardVaultAmount[valutKey] = info.amount
      }
      for (const item of updateRewardInfos) {
        const vaultAmount = rewardVaultAmount[item.tokenVault.toString()]
        item.remainingRewards = vaultAmount !== undefined ? vaultAmount.sub(item.rewardTotalEmissioned.sub(item.rewardClaimed)) : ZERO
      }
    }

    return poolsInfo
  }

  static async fetchMultiplePoolTickArrays({ connection, poolKeys, batchRequest }: { connection: Connection, poolKeys: AmmV3PoolInfo[], batchRequest?: boolean }): Promise<ReturnTypeFetchMultiplePoolTickArrays> {
    const tickArraysToPoolId: {[key: string]: PublicKey} = {}
    const tickArrays: { pubkey: PublicKey }[] = []
    for (const itemPoolInfo of poolKeys) {
      const tickArrayBitmap = TickUtils.mergeTickArrayBitmap(itemPoolInfo.tickArrayBitmap);
      const currentTickArrayStartIndex = TickUtils.getTickArrayStartIndexByTick(itemPoolInfo.tickCurrent, itemPoolInfo.tickSpacing);

      const startIndexArray = TickUtils.getInitializedTickArrayInRange(tickArrayBitmap, itemPoolInfo.tickSpacing, currentTickArrayStartIndex, Math.floor(FETCH_TICKARRAY_COUNT / 2));
      for (const itemIndex of startIndexArray) {
        const { publicKey: tickArrayAddress } = getPdaTickArrayAddress(
          itemPoolInfo.programId,
          itemPoolInfo.id,
          itemIndex
        );
        tickArrays.push({ pubkey: tickArrayAddress });
        tickArraysToPoolId[tickArrayAddress.toString()] = itemPoolInfo.id
      }
    }

    const fetchedTickArrays = (await getMultipleAccountsInfoWithCustomFlags(connection, tickArrays, { batchRequest }))

    const tickArrayCache: ReturnTypeFetchMultiplePoolTickArrays = {}

    for (const itemAccountInfo of fetchedTickArrays) {
      if (!itemAccountInfo.accountInfo) continue
      const poolId = tickArraysToPoolId[itemAccountInfo.pubkey.toString()]
      if (!poolId) continue
      if (tickArrayCache[poolId.toString()] === undefined) tickArrayCache[poolId.toString()] = {}

      const accountLayoutData = TickArrayLayout.decode(itemAccountInfo.accountInfo.data)

      tickArrayCache[poolId.toString()][accountLayoutData.startTickIndex] = {
        ...accountLayoutData,
        address: itemAccountInfo.pubkey
      }
    }
    return tickArrayCache;
  }

  static async getWhiteListMint({ connection, programId }: { connection: Connection, programId: PublicKey }) {
    const accountInfo = await connection.getAccountInfo(getPdaOperationAccount(programId).publicKey)
    if (!accountInfo) return []
    const whitelistMintsInfo = OperationLayout.decode(accountInfo.data)
    return whitelistMintsInfo.whitelistMints.filter(i => !i.equals(PublicKey.default))
  }
}
