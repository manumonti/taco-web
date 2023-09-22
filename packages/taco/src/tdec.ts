import {
  AccessControlPolicy,
  combineDecryptionSharesSimple,
  Context,
  DecryptionShareSimple,
  DkgPublicKey,
  EncryptedThresholdDecryptionRequest,
  EncryptedThresholdDecryptionResponse,
  encryptForDkg,
  FerveoVariant,
  SecretKey,
  SessionSharedSecret,
  SessionStaticSecret,
  Signer,
  ThresholdDecryptionRequest,
  ThresholdMessageKit,
} from '@nucypher/nucypher-core';
import {
  ConditionContext,
  ConditionExpression,
  DkgCoordinatorAgent,
  DkgParticipant,
  PorterClient,
  toBytes,
} from '@nucypher/shared';
import { ethers } from 'ethers';
import { arrayify, keccak256 } from 'ethers/lib/utils';

export const encryptMessageCbd = (
  plaintext: Uint8Array | string,
  encryptingKey: DkgPublicKey,
  conditions: ConditionExpression,
  authorizationSigner?: Signer,
): ThresholdMessageKit => {
  if (!authorizationSigner) {
    authorizationSigner = new Signer(SecretKey.random());
  }

  const [ciphertext, authenticatedData] = encryptForDkg(
    plaintext instanceof Uint8Array ? plaintext : toBytes(plaintext),
    encryptingKey,
    conditions.toWASMConditions(),
  );

  const headerHash = keccak256(ciphertext.header.toBytes());
  const authorization = authorizationSigner.sign(arrayify(headerHash));
  const acp = new AccessControlPolicy(
    authenticatedData,
    authorization.toBEBytes(),
  );

  return new ThresholdMessageKit(ciphertext, acp);
};

// Retrieve and decrypt ciphertext using provider and condition expression
export const retrieveAndDecrypt = async (
  provider: ethers.providers.Provider,
  porterUri: string,
  thresholdMessageKit: ThresholdMessageKit,
  ritualId: number,
  threshold: number,
  signer?: ethers.Signer,
): Promise<Uint8Array> => {
  const decryptionShares = await retrieve(
    provider,
    porterUri,
    thresholdMessageKit,
    ritualId,
    threshold,
    signer,
  );
  const sharedSecret = combineDecryptionSharesSimple(decryptionShares);
  return thresholdMessageKit.decryptWithSharedSecret(sharedSecret);
};

// Retrieve decryption shares
const retrieve = async (
  provider: ethers.providers.Provider,
  porterUri: string,
  thresholdMessageKit: ThresholdMessageKit,
  ritualId: number,
  threshold: number,
  signer?: ethers.Signer,
): Promise<DecryptionShareSimple[]> => {
  const dkgParticipants = await DkgCoordinatorAgent.getParticipants(
    provider,
    ritualId,
  );
  const wasmContext = await ConditionContext.fromConditions(
    provider,
    thresholdMessageKit.acp.conditions,
    signer,
  ).toWASMContext();
  const { sharedSecrets, encryptedRequests } = await makeDecryptionRequests(
    ritualId,
    wasmContext,
    dkgParticipants,
    thresholdMessageKit,
  );

  const porter = new PorterClient(porterUri);
  const { encryptedResponses, errors } = await porter.cbdDecrypt(
    encryptedRequests,
    threshold,
  );
  if (Object.keys(encryptedResponses).length < threshold) {
    throw new Error(
      `Threshold of responses not met; CBD decryption failed with errors: ${JSON.stringify(
        errors,
      )}`,
    );
  }

  return makeDecryptionShares(encryptedResponses, sharedSecrets, ritualId);
};

const makeDecryptionShares = (
  encryptedResponses: Record<string, EncryptedThresholdDecryptionResponse>,
  sessionSharedSecret: Record<string, SessionSharedSecret>,
  expectedRitualId: number,
) => {
  const decryptedResponses = Object.entries(encryptedResponses).map(
    ([ursula, response]) => response.decrypt(sessionSharedSecret[ursula]),
  );

  const ritualIds = decryptedResponses.map(({ ritualId }) => ritualId);
  if (ritualIds.some((ritualId) => ritualId !== expectedRitualId)) {
    throw new Error(
      `Ritual id mismatch. Expected ${expectedRitualId}, got ${ritualIds}`,
    );
  }

  return decryptedResponses.map(({ decryptionShare }) =>
    DecryptionShareSimple.fromBytes(decryptionShare),
  );
};

const makeDecryptionRequests = async (
  ritualId: number,
  wasmContext: Context,
  dkgParticipants: Array<DkgParticipant>,
  thresholdMessageKit: ThresholdMessageKit,
): Promise<{
  sharedSecrets: Record<string, SessionSharedSecret>;
  encryptedRequests: Record<string, EncryptedThresholdDecryptionRequest>;
}> => {
  const decryptionRequest = new ThresholdDecryptionRequest(
    ritualId,
    FerveoVariant.simple,
    thresholdMessageKit.ciphertextHeader,
    thresholdMessageKit.acp,
    wasmContext,
  );

  const ephemeralSessionKey = makeSessionKey();

  // Compute shared secrets for each participant
  const sharedSecrets: Record<string, SessionSharedSecret> = Object.fromEntries(
    dkgParticipants.map(({ provider, decryptionRequestStaticKey }) => {
      const sharedSecret = ephemeralSessionKey.deriveSharedSecret(
        decryptionRequestStaticKey,
      );
      return [provider, sharedSecret];
    }),
  );

  // Create encrypted requests for each participant
  const encryptedRequests: Record<string, EncryptedThresholdDecryptionRequest> =
    Object.fromEntries(
      Object.entries(sharedSecrets).map(([provider, sessionSharedSecret]) => {
        const encryptedRequest = decryptionRequest.encrypt(
          sessionSharedSecret,
          ephemeralSessionKey.publicKey(),
        );
        return [provider, encryptedRequest];
      }),
    );

  return { sharedSecrets, encryptedRequests };
};

// Moving to a separate function to make it easier to mock
// TODO: Reconsider this
const makeSessionKey = () => SessionStaticSecret.random();
