import { Address, SignableMessage } from '@multiversx/sdk-core/out';
import { UserPublicKey, UserVerifier } from '@multiversx/sdk-wallet/out';
import { Probot } from 'probot';
import axios from 'axios';

export const robot = (app: Probot) => {
  app.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async (context) => {
      try {
        const repo = context.repo();
        console.log("Starting processing the assets ownership checks");

        async function createComment(body: string) {
          try {
            await context.octokit.issues.createComment({
              repo: context.repo().repo,
              owner: context.repo().owner,
              issue_number: context.pullRequest().pull_number,
              body,
            });
          } catch (error) {
            console.error(`An error occurred while leaving comment '${JSON.stringify(body)}'`);
            console.error(error);
          }
        }

        async function getIdentityOwners(files: { filename: string, raw_url: string }[]): Promise<string[]> {
          const originalOwners: string[] = [];
          const newOwners: string[] = [];
          const networkPath = network === 'mainnet' ? '' : `${network}/`;

          const infoJsonUrl = `https://raw.githubusercontent.com/multiversx/mx-assets/master/${networkPath}identities/${asset}/info.json`;

          // we try to read the contents of the info.json file
          const { data: infoFromMaster } = await axios.get(infoJsonUrl, { validateStatus: status => [200, 404].includes(status) });

          if (infoFromMaster && typeof infoFromMaster === 'object' && infoFromMaster['owners']) {
            originalOwners.push(...infoFromMaster.owners);
          }

          const infoJsonFile = files.find(x => x.filename.endsWith(`/${asset}/info.json`));
          if (infoJsonFile) {
            const { data: infoFromPullRequest } = await axios.get(infoJsonFile.raw_url);

            if (infoFromPullRequest && typeof infoFromPullRequest === 'object' && infoFromPullRequest['owners']) {
              newOwners.push(...infoFromPullRequest.owners);
            }
          }

          let mainOwner = '';
          if (originalOwners.length > 0) {
            mainOwner = originalOwners[0];
          } else if (newOwners.length > 0) {
            mainOwner = newOwners[0];
          }

          const extraOwners = newOwners.filter(x => !originalOwners.includes(x));

          const printableFilenames = files.map(file => file.filename).join(', ');
          console.log(`Names of changed files: ${printableFilenames}. original owners=${originalOwners}. new owners: ${newOwners}`);

          const allOwners: string[] = [];
          const allOwnersToCheck = [mainOwner, ...extraOwners];

          const apiUrl = getApiUrl();

          for (const owner of allOwnersToCheck) {
            const alreadyExistingBranding = await isProviderAlreadyBranded(apiUrl, asset as string, owner);
            if (alreadyExistingBranding && alreadyExistingBranding.existing && !alreadyExistingBranding.isUpdate) {
              await fail(`${owner} is already branded. Only updates are allowed.`);
              return [];
            }
            if (new Address(owner).isContractAddress()) {
              const ownerResult = await fetchStringValueFromApi(apiUrl, "accounts", owner, "ownerAddress");
              if (ownerResult) {
                allOwners.push(ownerResult);
              }
            } else {
              allOwners.push(owner);
            }
          }

          return [...new Set(allOwners)];
        }

        async function isProviderAlreadyBranded(apiUrl: string, identity: string, provider: string): Promise<{
          existing: boolean,
          isUpdate?: boolean
        }> {
          try {
            const providerInfo = await axios.get(`${apiUrl}/providers/${provider}`);
            if (!providerInfo) {
              return { existing: false };
            }

            if (!providerInfo.data?.identity) {
              return { existing: false };
            }

            return {
              existing: true,
              isUpdate: identity === providerInfo.data?.identity,
            };
          } catch (error) {
            console.error(`API error while fetching the provider data for address ${provider}: ${error}`);
            return { existing: false };
          }
        }

        async function getAccountOwner(account: string): Promise<string> {
          const accountOwner = account;
          if (new Address(accountOwner).isContractAddress()) {
            return getAccountOwnerFromApi(accountOwner);
          }

          return accountOwner;
        }

        async function getAccountOwnerFromApi(address: string): Promise<string> {
          const apiUrl = getApiUrl();
          return await fetchStringValueFromApi(apiUrl, "accounts", address, "ownerAddress");
        }

        async function validateTokenAndGetOwner(files: { filename: string, raw_url: string }[], token: string): Promise<string> {
          // since the token owner can be changed at protocol level at any time, it's enough to check the ownership of the token,
          // without checking any previous owners
          const apiUrl = getApiUrl();

          await checkIfTickerAlreadyExists(token);

          await checkExtraTokensFields(files, token);

          const tokenOwner = await getTokenOwnerFromApi(token, apiUrl);
          if (new Address(tokenOwner).isContractAddress()) {
            return await fetchStringValueFromApi(apiUrl, "accounts", tokenOwner, "ownerAddress");
          }

          return tokenOwner;
        }

        async function checkExtraTokensFields(files: { filename: string, raw_url: string }[], token: string): Promise<void> {
          const infoJsonFile = files.find(x => x.filename.endsWith(`/${token}/info.json`));
          if (infoJsonFile) {
            const { data: infoFromPullRequest } = await axios.get(infoJsonFile.raw_url);

            if (infoFromPullRequest && typeof infoFromPullRequest === 'object' && infoFromPullRequest['lockedAccounts']) {
              for (const lockedAccount in infoFromPullRequest.lockedAccounts) {
                if (lockedAccount.length !== 62) {
                  await fail(`Invalid locked accounts: ${lockedAccount}`);
                }
              }
            }

            if (infoFromPullRequest && typeof infoFromPullRequest === 'object' && infoFromPullRequest['extraTokens']) {
              for (const extra of infoFromPullRequest.extraTokens) {
                if (!validateTokenIdentifier(extra)) {
                  await fail(`Invalid extra token: ${extra}`);
                }
              }
            }
          }
        }

        function validateTokenIdentifier(input: string): boolean {
          // Regular expression for the specified format
          const regex = /^[A-Z0-9]{3,10}-[a-f0-9]{6}$/;

          // Test the input string against the regex
          return regex.test(input);
        }

        async function getTokenOwnerFromApi(token: string, apiUrl: string): Promise<string> {
          return await fetchStringValueFromApi(apiUrl, "tokens", token, "owner") ||
            await fetchStringValueFromApi(apiUrl, "collections", token, "owner");
        }

        /**
         * Multisig support: a smart contract can never produce an ed25519 message
         * signature, so when an asset's resolved owner is a multisig SC the check
         * was impossible to satisfy. Expand such owners to the multisig's on-chain
         * BOARD MEMBERS (getAllBoardMembers view) and accept a signature from any
         * one of them — a board member signing the commit sha proves the same
         * insider control the owner signature was designed to prove.
         */
        async function expandMultisigOwners(owners: string[]): Promise<{ owners: string[], multisig: boolean }> {
          const apiUrl = getApiUrl();
          const expanded: string[] = [];
          let multisig = false;
          for (const owner of owners) {
            if (!owner || !new Address(owner).isContractAddress()) {
              expanded.push(owner);
              continue;
            }
            try {
              const response = await axios.post(`${apiUrl}/query`, {
                scAddress: owner,
                funcName: 'getAllBoardMembers',
                args: [],
              });
              const returnData: string[] = response?.data?.returnData ?? [];
              const members = returnData
                .filter((x) => x)
                .map((x) => Buffer.from(x, 'base64'))
                .filter((b) => b.length === 32)
                .map((b) => new Address(b).bech32());
              if (members.length > 0) {
                multisig = true;
                expanded.push(...members);
                console.log(`Owner ${owner} is a multisig — accepting signatures from board members: ${members}`);
                continue;
              }
            } catch (error) {
              console.error(`getAllBoardMembers query failed for ${owner}: ${error}`);
            }
            expanded.push(owner); // not a multisig (or query failed) — unchanged behaviour
          }
          return { owners: [...new Set(expanded)], multisig };
        }

        async function fetchStringValueFromApi(apiUrl: string, endpoint: string, query: string, extract?: string): Promise<string> {
          let requestUrl = `${apiUrl}/${endpoint}/${query}`;
          if (extract) {
            requestUrl += `?extract=${extract}`;
          }
          try {
            const response = await axios.get(requestUrl);
            return response.data;
          } catch (error) {
            console.error(`Cannot query API at ${requestUrl} : ${error}`);
            return '';
          }
        }

        function getApiUrl() {
          switch (network) {
            case 'mainnet':
              return 'https://next-api.multiversx.com';
            case 'devnet':
              return 'https://devnet-api.multiversx.com';
            case 'testnet':
              return 'https://testnet-api.multiversx.com';
          }

          throw new Error(`Invalid network: ${network}`);
        }

        function getDistinctNetworks(fileNames: string[]) {
          const networks = fileNames.map(fileName => getNetwork(fileName)).filter(x => x !== undefined);

          return [...new Set(networks)];
        }

        function getNetwork(fileName: string): 'mainnet' | 'devnet' | 'testnet' | undefined {
          const mainnetRegex = /^(identities|accounts|tokens)\b/;
          const testnetRegex = /^testnet\/(identities|accounts|tokens)\b/;
          const devnetRegex = /^devnet\/(identities|accounts|tokens)\b/;

          if (mainnetRegex.test(fileName)) {
            return 'mainnet';
          }

          if (testnetRegex.test(fileName)) {
            return 'testnet';
          }

          if (devnetRegex.test(fileName)) {
            return 'devnet';
          }

          return undefined;
        }


        function getDistinctIdentities(fileNames: string[]) {
          const regex = /identities\/(.*?)\//;

          const identities = fileNames
            .map(x => regex.exec(x)?.at(1))
            .filter(x => x);

          return [...new Set(identities)];
        }

        function getDistinctAccounts(fileNames: string[]) {
          const regex = /accounts\/(.*?).json/;

          const accounts = fileNames
            .map(x => regex.exec(x)?.at(1))
            .filter(x => x);

          return [...new Set(accounts)];
        }

        function getDistinctTokens(fileNames: string[]) {
          const regex = /tokens\/(.*?)\/info.json/;

          const tokens = fileNames
            .map(x => regex.exec(x)?.at(1))
            .filter(x => x);

          return [...new Set(tokens)];
        }

        async function checkIfTickerAlreadyExists(tokenName: string) {
          const tokensDirPath = (network === "mainnet") ? "/tokens" : `/${network}/tokens`;
          const response = await context.octokit.repos.getContent({
            owner: context.repo().owner,
            repo: context.repo().repo,
            path: tokensDirPath,
          });

          const tokenTicker = tokenName.split("-")[0];
          if (!tokenTicker) {
            return;
          }
          const tokensDirectories = (response.data && (response.data as any[]).length) ? response.data as any[] : [];
          const subdirectoriesWithSameTicker = tokensDirectories.filter(
            (content) => content?.type === "dir" && content?.name?.startsWith(`${tokenTicker}-`),
          );

          if (subdirectoriesWithSameTicker.length) {
            const existingToken = subdirectoriesWithSameTicker[0].name;
            if (existingToken === tokenName) {
              // it's just an update to the same token
              return;
            }

            await fail(`Token with ticker ${tokenTicker} already exists! Existing token id=${existingToken}. New token id=${tokenName}`);
          }
        }

        async function fail(reason: string) {
          await createComment(reason);
          console.error(reason);
          process.exit(1);
        }

        async function verify(body: string, address: string, message: string): Promise<boolean | undefined> {
          const signature = /[0-9a-fA-F]{128}/.exec(body)?.at(0);
          if (signature) {
            const verifyResult = await verifySignature(signature, address, message);
            console.log(`Verifying signature for address ${address}, message ${message}, and signature ${signature}. Result=${verifyResult}`);
            return verifyResult;
          }

          const txHash = /[0-9a-fA-F]{64}/.exec(body)?.at(0);
          if (txHash) {
            return verifyTxHash(txHash, address, message);
          }

          return undefined;
        }

        async function verifyTxHash(_txHash: string, _address: string, _message: string): Promise<boolean | undefined> {
          console.log('verifyTxHash not implemented yet');
          return false;
        }

        async function verifySignature(signature: string, address: string, message: string): Promise<boolean | undefined> {
          const signableMessage = new SignableMessage({
            address: new Address(address),
            message: Buffer.from(message, 'utf8'),
            signature: Buffer.from(signature, 'hex'),
          });

          const publicKey = new UserPublicKey(
            new Address(address).pubkey(),
          );

          const verifier = new UserVerifier(publicKey);
          return verifier.verify(signableMessage.serializeForSigning(), signableMessage.getSignature());
        }

        async function multiVerify(bodies: string[], addresses: string[], messages: string[]): Promise<string[] | undefined> {
          if (addresses.length === 0) {
            return undefined;
          }

          const addressSet = new Set(addresses);

          for (const message of messages) {
            for (const body of bodies) {
              const lines = body.split('\n');
              for (const line of lines) {
                for (const address of addresses) {
                  const result = await verify(line, address, message);
                  if (result === true) {
                    console.info(`Successfully verified that message '${message}' was signed correctly using the address '${address}'`);
                    addressSet.delete(address);
                  }
                }
              }
            }
          }

          return [...addressSet];
        }

        const { data: pullRequest } = await axios.get(`https://api.github.com/repos/multiversx/mx-assets/pulls/${context.pullRequest().pull_number}`);
        const state = pullRequest.state;

        if (state === 'closed' || state === 'locked' || state === 'draft') {
          await fail(`Invalid PR state: ${state}`);
          return 'invalid event payload';
        }

        const data = await context.octokit.repos.compareCommits({
          owner: repo.owner,
          repo: repo.repo,
          base: pullRequest.base.sha,
          head: pullRequest.head.sha,
        });

        let { files: changedFiles, commits } = data.data;

        const lastCommitSha = commits[commits.length - 1].sha;
        const commitShas = commits.map(x => x.sha);

        if (!changedFiles?.length) {
          return 'no change';
        }

        let checkMode = 'identity';
        const changedFilesNames = changedFiles.map(x => x.filename);
        const distinctStakingIdentities = getDistinctIdentities(changedFilesNames);
        const distinctAccounts = getDistinctAccounts(changedFilesNames);
        const distinctTokens = getDistinctTokens(changedFilesNames);

        const countDistinctStakingIdentities = distinctStakingIdentities.length;
        if (countDistinctStakingIdentities) {
          checkMode = 'identity';
        }
        const countDistinctAccounts = distinctAccounts.length;
        if (countDistinctAccounts) {
          checkMode = 'account';
        }
        const countDistinctTokens = distinctTokens.length;
        if (countDistinctTokens) {
          checkMode = 'token';
        }

        const sumOfAllChangedAssets = countDistinctAccounts + countDistinctStakingIdentities + countDistinctTokens;
        if (sumOfAllChangedAssets === 0) {
          console.log("No identity, token or account changed.");
          return;
        }
        if (sumOfAllChangedAssets > 1) {
          await fail("Only one identity, token or account update at a time.");
          return;
        }

        const distinctIdentities = [...distinctStakingIdentities, ...distinctAccounts, ...distinctTokens];

        const distinctNetworks = getDistinctNetworks(changedFiles.map(x => x.filename));
        if (distinctNetworks.length === 0) {
          await fail("No network changed.");
          return;
        }

        const comments = await context.octokit.issues.listComments({
          repo: context.repo().repo,
          owner: context.repo().owner,
          issue_number: context.pullRequest().pull_number,
          per_page: 100,
        });

        const body = pullRequest.body || '';

        const bodies = [...comments.data.map(x => x.body || ''), body];

        let adminAddress = process.env.ADMIN_ADDRESS;
        if (!adminAddress) {
          adminAddress = 'erd1cevsw7mq5uvqymjqzwqvpqtdrhckehwfz99n7praty3y7q2j7yps842mqh';
        }

        const invalidAddressesForAdminChecks = await multiVerify(bodies, [adminAddress], commitShas);
        if (invalidAddressesForAdminChecks && invalidAddressesForAdminChecks.length === 0) {
          await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the admin wallet address`);
          return;
        }

        if (distinctIdentities.length > 1) {
          await fail('Only one identity must be edited at a time');
          return;
        }

        if (distinctNetworks.length > 1) {
          await fail('Only one network must be edited at a time');
          return;
        }

        const asset = distinctIdentities[0];
        if (!asset) {
          await fail('No asset update detected');
          return;
        }
        const network = distinctNetworks[0];

        let owners: string[];
        switch (checkMode) {
          case 'identity':
            owners = await getIdentityOwners(changedFiles);
            break;
          case 'account':
            const accountOwner = await getAccountOwner(asset);
            owners = [accountOwner];
            break;
          case 'token':
            const tokenOwner = await validateTokenAndGetOwner(changedFiles, asset);
            owners = [tokenOwner];
            break;
          default:
            owners = [];
        }

        if (owners.length === 0) {
          await fail('No owners identified');
          return;
        }

        // Contract-owned assets: expand multisig owners to their board members
        // (any single board member's signature is accepted — see helper above).
        const { owners: effectiveOwners, multisig } = await expandMultisigOwners(owners);

        console.log(`Asset owners. check mode=${checkMode}. multisig=${multisig}. value=${effectiveOwners}. Commit shas=${commitShas}`);
        const invalidAddresses = await multiVerify(bodies, effectiveOwners, commitShas);
        if (!invalidAddresses) {
          await fail('Failed to verify owners');
          return;
        }

        const verifiedCount = effectiveOwners.length - invalidAddresses.length;
        const signatureOk = multisig ? verifiedCount >= 1 : invalidAddresses.length === 0;

        const addressDescription = effectiveOwners.length > 1 ? 'addresses' : 'address';

        if (!signatureOk) {
          const wanted = effectiveOwners.map(address => `\`${address}\``).join('\n');
          const requirement = multisig
            ? `signed with ANY board member of the owner multisig`
            : `signed with the owner wallet ${addressDescription}`;
          await fail(`Please provide a signature for the latest commit sha: \`${lastCommitSha}\` which must be ${requirement}: \n${wanted}`);
          return;
        } else {
          const verifiedOwners = effectiveOwners.filter(a => !invalidAddresses.includes(a));
          const ownersDescription = verifiedOwners.map((address: any) => `\`${address}\``).join('\n');
          await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the ${multisig ? 'multisig board member ' : ''}wallet ${verifiedOwners.length > 1 ? 'addresses' : 'address'}: \n${ownersDescription}`);
        }

        console.info('successfully reviewed', pullRequest.html_url);
        return 'success';
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    },
  );
};
