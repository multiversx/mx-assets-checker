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

          const infoJsonUrl = `https://raw.githubusercontent.com/multiversx/mx-assets/master/${networkPath}identities/${identity}/info.json`;

          // we try to read the contents of the info.json file
          const { data: infoFromMaster } = await axios.get(infoJsonUrl, { validateStatus: status => [200, 404].includes(status) });

          if (infoFromMaster && typeof infoFromMaster === 'object' && infoFromMaster['owners']) {
            originalOwners.push(...infoFromMaster.owners);
          }

          const infoJsonFile = files.find(x => x.filename.endsWith(`/${identity}.json`));
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

          const allOwners: string[] = [];
          const allOwnersToCheck = [mainOwner, ...extraOwners];

          let apiUrl = 'https://next-api.multiversx.com';
          if (network === 'devnet') {
            apiUrl = 'https://devnet-api.multiversx.com';
          } else if (network === 'testnet') {
            apiUrl = 'https://testnet-api.multiversx.com';
          }

          for (const owner of allOwnersToCheck) {
            if (new Address(owner).isContractAddress()) {
              const ownerResult = await axios.get(`${apiUrl}/accounts/${owner}?extract=ownerAddress`);
              allOwners.push(ownerResult.data);
            } else {
              allOwners.push(owner);
            }
          }

          return [...new Set(allOwners)];
        }

        async function getAccountOwner(files: { filename: string, raw_url: string }[]): Promise<string[]> {
          const originalOwner = identity;
          let newOwner: string = '';

          const infoJsonFile = files.find(x => x.filename.endsWith(`/${identity}.info.json`));
          if (infoJsonFile) {
            const { data: infoFromPullRequest } = await axios.get(infoJsonFile.raw_url);

            if (infoFromPullRequest && typeof infoFromPullRequest === 'object') {
              console.log(`typeof infoFromPullRequest = ${typeof infoFromPullRequest}. infoJsonFile=${infoJsonFile}. infoFromPullRequest=${infoFromPullRequest}`);
              newOwner = identity ?? '';
            }
          }

          let apiUrl = 'https://next-api.multiversx.com';
          if (network === 'devnet') {
            apiUrl = 'https://devnet-api.multiversx.com';
          } else if (network === 'testnet') {
            apiUrl = 'https://testnet-api.multiversx.com';
          }

          const allOwners: string[] = [];
          let allOwnersToCheck: string[] = [];
          if (newOwner) {
            allOwnersToCheck = [...allOwnersToCheck, newOwner];
          }
          if (originalOwner) {
            allOwnersToCheck = [...allOwnersToCheck, originalOwner];
          }

          for (const owner of allOwnersToCheck) {
            if (new Address(owner).isContractAddress()) {
              const ownerResult = await axios.get(`${apiUrl}/accounts/${owner}?extract=ownerAddress`);
              allOwners.push(ownerResult.data);
            } else {
              allOwners.push(owner);
            }
          }

          return [...new Set(allOwners)];
        }

        function getDistinctNetworks(fileNames: string[]) {
          const networks = fileNames.map(fileName => getNetwork(fileName)).filter(x => x !== undefined);

          return [...new Set(networks)];
        }

        function getNetwork(fileName: string): 'mainnet' | 'devnet' | 'testnet' | undefined {
          if (fileName.startsWith('identities') || fileName.startsWith('accounts')) {
            return 'mainnet';
          }

          if (fileName.startsWith('testnet/identities') || fileName.startsWith('testnet/accounts')) {
            return 'testnet';
          }

          if (fileName.startsWith('devnet/identities') || fileName.startsWith('devnet/accounts')) {
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

        async function fail(reason: string) {
          await createComment(reason);
          console.error(reason);
          process.exit(1);
        }

        async function verify(body: string, address: string, message: string): Promise<boolean | undefined> {
          const signature = /[0-9a-fA-F]{128}/.exec(body)?.at(0);
          if (signature) {
            return verifySignature(signature, address, message);
          }

          const txHash = /[0-9a-fA-F]{64}/.exec(body)?.at(0);
          if (txHash) {
            return verifyTxHash(txHash, address, message);
          }

          return undefined;
        }

        async function verifyTxHash(_txHash: string, _address: string, _message: string): Promise<boolean | undefined> {
          throw new Error('Not implemented yet');
        }

        async function verifySignature(signature: string, address: string, message: string): Promise<boolean | undefined> {
          const signableMessage = new SignableMessage({
            address: new Address(address),
            message: Buffer.from(message, 'utf8'),
          });

          const publicKey = new UserPublicKey(
            new Address(address).pubkey(),
          );

          const verifier = new UserVerifier(publicKey);
          return verifier.verify(signableMessage.serializeForSigning(), Buffer.from(signature, 'hex'));
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
        console.log({ changedFiles });
        const distinctStakingIdentities = getDistinctIdentities(changedFilesNames);
        const distinctAccounts = getDistinctAccounts(changedFilesNames);

        const countDistinctStakingIdentities = distinctStakingIdentities.length;
        const countDistinctAccounts = distinctAccounts.length;
        if (countDistinctStakingIdentities === 0 && countDistinctAccounts === 0) {
          await fail("No identity or account changed.");
          return;
        }

        if (countDistinctAccounts) {
          if (countDistinctStakingIdentities) {
            await fail("Only one identity or account update at a time.");
            return;
          }
          checkMode = 'account';
        }

        const distinctIdentities = [...distinctStakingIdentities, ...distinctAccounts];

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

        if (adminAddress) {
          const invalidAddresses = await multiVerify(bodies, [adminAddress], commitShas);
          if (invalidAddresses && invalidAddresses.length === 0) {
            await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the admin wallet address`);
            return;
          }
        }

        if (distinctIdentities.length > 1) {
          await fail('Only one identity must be edited at a time');
          return;
        }

        if (distinctNetworks.length > 1) {
          await fail('Only one network must be edited at a time');
          return;
        }

        const identity = distinctIdentities[0];
        const network = distinctNetworks[0];

        let owners: string[];
        if (checkMode == 'identity') {
          owners = await getIdentityOwners(changedFiles);
        } else {
          owners = await getAccountOwner(changedFiles);
        }
        if (owners.length === 0) {
          await fail('No owners identified');
          return;
        }

        console.log(`identity owners. check mode=${checkMode}. value=${owners}`);
        const invalidAddresses = await multiVerify(bodies, owners, commitShas);
        if (!invalidAddresses) {
          await fail('Failed to verify owners');
          return;
        }

        const addressDescription = invalidAddresses.length > 1 ? 'addresses' : 'address';
        const invalidAddressesDescription = invalidAddresses.map(address => `\`${address}\``).join('\n');

        if (invalidAddresses.length > 0) {
          await fail(`Please provide a signature for the latest commit sha: \`${lastCommitSha}\` which must be signed with the owner wallet ${addressDescription}: \n${invalidAddressesDescription}`);
          return;
        } else {
          const ownersDescription = owners.map((address: any) => `\`${address}\``).join('\n');
          await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the wallet ${addressDescription}: \n${ownersDescription}`);
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
