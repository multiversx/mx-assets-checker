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

        async function createComment(body: string) {
          await context.octokit.issues.createComment({
            repo: context.repo().repo,
            owner: context.repo().owner,
            issue_number: context.pullRequest().pull_number,
            body,
          });
        }

        async function getOwners(files: {filename: string, raw_url: string}[]): Promise<string[]> {
          const originalOwners: string[] = [];
          const newOwners: string[] = [];

          // we try to read the contents of the info.json file
          const { data: infoFromMaster } = await axios.get(`https://raw.githubusercontent.com/multiversx/mx-assets/master/identities/${identity}/info.json`, { validateStatus: status => [200, 404].includes(status) });

          if (infoFromMaster && typeof infoFromMaster === 'object' && infoFromMaster['owners']) {
            originalOwners.push(...infoFromMaster.owners);
          }
          
          const infoJsonFile = files.find(x => x.filename.endsWith(`/${identity}/info.json`));
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
          const allOwnersToCheck = [ mainOwner, ...extraOwners ];

          for (const owner of allOwnersToCheck) {
            if (new Address(owner).isContractAddress()) {
              const ownerResult = await axios.get(`https://next-api.multiversx.com/accounts/${owner}?extract=ownerAddress`);
              allOwners.push(ownerResult.data);
            } else {
              allOwners.push(owner);
            }
          }

          return [...new Set(allOwners)];
        }

        function getDistinctIdentities(fileNames: string[]) {
          const regex = /^identities\/(.*?)\//;

          const identities = fileNames
            .map(x => regex.exec(x)?.at(1))
            .filter(x => x);
    
          return [...new Set(identities)];
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

        async function multiVerify(bodies: string[], addresses: string[], message: string): Promise<boolean | undefined> {
          if (addresses.length === 0) {
            return undefined;
          }

          const resultDict: Record<string, boolean> = {};

          for (const body of bodies) {
            const lines = body.split('\n');
            for (const line of lines) {
              for (const address of addresses) {
                const result = await verify(line, address, message);
                if (result === true) {
                  resultDict[address] = true;
                }
              }
            }
          }
          
          return Object.keys(resultDict).length === addresses.length ? true : undefined;
        }

        const { data: pullRequest } = await axios.get(`https://api.github.com/repos/multiversx/mx-assets/pulls/${context.pullRequest().pull_number}`);
        const state = pullRequest.state;

        if (state === 'closed' || state === 'locked' || state === 'draft') {
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

        if (!changedFiles?.length) {
          return 'no change';
        }

        const distinctIdentities = getDistinctIdentities(changedFiles.map(x => x.filename));
        if (distinctIdentities.length === 0) {
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

        const adminAddress = process.env.ADMIN_ADDRESS;
        if (adminAddress) {
          const result = await multiVerify(bodies, [adminAddress], lastCommitSha);
          if (result === true) {
            await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the admin wallet address`);
            return;
          }
        }

        if (distinctIdentities.length > 1) {
          await fail('Only one identity must be edited at a time');
          return;
        }

        const identity = distinctIdentities[0];

        let owners = await getOwners(changedFiles);

        const addressDescription = owners.length > 1 ? 'addresses' : 'address';
        const ownersDescription = owners.map(owner => `\`${owner}\``).join('\n');

        const valid = await multiVerify(bodies, owners, lastCommitSha);
        if (valid === undefined) {
          await fail(`Please provide a signature for the latest commit sha: \`${lastCommitSha}\` which must be signed with the owner wallet ${addressDescription}: \n${ownersDescription}`);
          return;
        }

        if (valid === false) {
          await fail(`The provided signature is invalid. Please provide a signature for the latest commit sha: \`${lastCommitSha}\` which must be signed with the owner wallet ${addressDescription}: \n${ownersDescription}`);
          return;
        } else {
          await createComment(`Signature OK. Verified that the latest commit hash \`${lastCommitSha}\` was signed using the wallet ${addressDescription}: \n${ownersDescription}`);
        }

        console.info('successfully reviewed', pullRequest.html_url);
        return 'success';
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    }
  );
};
