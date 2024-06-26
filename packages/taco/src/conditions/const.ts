import { ChainId } from '@nucypher/shared';

export const USER_ADDRESS_PARAM = ':userAddress';

export const ETH_ADDRESS_REGEXP = new RegExp('^0x[a-fA-F0-9]{40}$');

// Only allow alphanumeric characters and underscores
export const CONTEXT_PARAM_REGEXP = new RegExp('^:[a-zA-Z_][a-zA-Z0-9_]*$');

export const CONTEXT_PARAM_PREFIX = ':';

export const SUPPORTED_CHAIN_IDS = [
  ChainId.POLYGON,
  ChainId.AMOY,
  ChainId.SEPOLIA,
  ChainId.ETHEREUM_MAINNET,
];

export const RESERVED_CONTEXT_PARAMS = [USER_ADDRESS_PARAM];
