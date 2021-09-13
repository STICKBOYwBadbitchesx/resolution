import {
  UnsSupportedNetwork,
  ProxyReaderMap,
  hasProvider,
  NullAddress,
} from './types';
import ResolutionError, {ResolutionErrorCode} from './errors/resolutionError';
import {
  constructRecords,
  isNullAddress,
  EthereumNetworksInverted,
  EthereumNetworks,
} from './utils';
import {
  UnsSource,
  CryptoRecords,
  DomainData,
  NamingServiceName,
  Provider,
  UnsLocation,
  DomainLocation,
  BlockchainType,
} from './types/publicTypes';
import {isValidTwitterSignature} from './utils/TwitterSignatureValidator';
import UnsConfig from './config/uns-config.json';
import FetchProvider from './FetchProvider';
import {eip137Childhash, eip137Namehash} from './utils/namehash';
import {NamingService} from './NamingService';
import ConfigurationError, {
  ConfigurationErrorCode,
} from './errors/configurationError';
import UnsInternal from './UnsInternal';

/**
 * @internal
 */
export default class Uns extends NamingService {
  static readonly ProxyReaderMap: ProxyReaderMap = getProxyReaderMap();

  public unsl1: UnsInternal;
  public unsl2: UnsInternal;
  readonly name: NamingServiceName = NamingServiceName.UNS;

  constructor(source?: UnsSource) {
    super();
    if (!source) {
      source = {
        locations: {
          Layer1: {
            url: UnsInternal.UrlMap['mainnet'],
            network: 'mainnet',
          },
          Layer2: {
            url: UnsInternal.UrlMap['polygon-mainnet'],
            network: 'polygon-mainnet',
          },
        },
      };
    }
    this.unsl1 = new UnsInternal(UnsLocation.Layer1, source.locations.Layer1);
    this.unsl2 = new UnsInternal(UnsLocation.Layer2, source.locations.Layer2);
  }

  static async autoNetwork(config: {
    locations: {
      Layer1: {url: string} | {provider: Provider};
      Layer2: {url: string} | {provider: Provider};
    };
  }): Promise<Uns> {
    let providerLayer1: Provider;
    let providerLayer2: Provider;

    if (
      hasProvider(config.locations.Layer1) &&
      hasProvider(config.locations.Layer2)
    ) {
      providerLayer1 = config.locations.Layer1.provider;
      providerLayer2 = config.locations.Layer2.provider;
    } else {
      if (!config.locations.Layer1['url'] || !config.locations.Layer2['url']) {
        throw new ConfigurationError(ConfigurationErrorCode.UnspecifiedUrl, {
          method: NamingServiceName.UNS,
        });
      }
      providerLayer1 = FetchProvider.factory(
        NamingServiceName.UNS,
        config.locations.Layer1['url'],
      );
      providerLayer2 = FetchProvider.factory(
        NamingServiceName.UNS,
        config.locations.Layer2['url'],
      );
    }

    const networkIdLayer1 = (await providerLayer1.request({
      method: 'net_version',
    })) as number;
    const networkIdLayer2 = (await providerLayer2.request({
      method: 'net_version',
    })) as number;
    const networkNameLayer1 = EthereumNetworksInverted[networkIdLayer1];
    const networkNameLayer2 = EthereumNetworksInverted[networkIdLayer2];
    if (
      !networkNameLayer1 ||
      !UnsSupportedNetwork.guard(networkNameLayer1) ||
      !networkNameLayer2 ||
      !UnsSupportedNetwork.guard(networkNameLayer2)
    ) {
      throw new ConfigurationError(ConfigurationErrorCode.UnsupportedNetwork, {
        method: NamingServiceName.UNS,
      });
    }
    return new this({
      locations: {
        Layer1: {network: networkNameLayer1, provider: providerLayer1},
        Layer2: {network: networkNameLayer2, provider: providerLayer2},
      },
    });
  }

  namehash(domain: string): string {
    if (!this.checkDomain(domain)) {
      throw new ResolutionError(ResolutionErrorCode.UnsupportedDomain, {
        domain,
      });
    }
    return eip137Namehash(domain);
  }

  childhash(parentHash: string, label: string): string {
    return eip137Childhash(parentHash, label);
  }

  serviceName(): NamingServiceName {
    return this.name;
  }

  async isSupportedDomain(domain: string): Promise<boolean> {
    if (!this.checkDomain(domain)) {
      return false;
    }
    const tld = domain.split('.').pop();
    if (!tld) {
      return false;
    }
    const [exists] = await this.unsl1.readerContract.call('exists', [
      this.namehash(tld),
    ]);
    return exists;
  }

  async owner(domain: string): Promise<string> {
    return (await this.getVerifiedData(domain)).owner;
  }

  async resolver(domain: string): Promise<string> {
    return (await this.getVerifiedData(domain)).resolver;
  }

  async record(domain: string, key: string): Promise<string> {
    const returnee = (await this.records(domain, [key]))[key];
    if (!returnee) {
      throw new ResolutionError(ResolutionErrorCode.RecordNotFound, {
        recordName: key,
        domain,
      });
    }
    return returnee;
  }

  async records(
    domain: string,
    keys: string[],
  ): Promise<Record<string, string>> {
    return (await this.getVerifiedData(domain, keys)).records;
  }

  async allRecords(domain: string): Promise<CryptoRecords> {
    const promiseL2 = this.unsl2.allRecords(domain);
    const promiseL1 = this.unsl1.allRecords(domain);
    const recordsL2 = await promiseL2.catch((error) => {
      if (
        error.code === ResolutionErrorCode.UnspecifiedResolver ||
        error.code === ResolutionErrorCode.UnregisteredDomain
      ) {
        return null;
      }
      throw error;
    });
    if (recordsL2 && recordsL2.owner && recordsL2.owner !== NullAddress) {
      return recordsL2;
    }
    return promiseL1;
  }

  async twitter(domain: string): Promise<string> {
    const tokenId = this.namehash(domain);
    const keys = [
      'validation.social.twitter.username',
      'social.twitter.username',
    ];
    const data = await this.getVerifiedData(domain, keys);
    const {records} = data;
    const validationSignature = records['validation.social.twitter.username'];
    const twitterHandle = records['social.twitter.username'];
    if (isNullAddress(validationSignature)) {
      throw new ResolutionError(ResolutionErrorCode.RecordNotFound, {
        domain,
        recordName: 'validation.social.twitter.username',
      });
    }

    if (!twitterHandle) {
      throw new ResolutionError(ResolutionErrorCode.RecordNotFound, {
        domain,
        recordName: 'social.twitter.username',
      });
    }

    const owner = data.owner;
    if (
      !isValidTwitterSignature({
        tokenId,
        owner,
        twitterHandle,
        validationSignature,
      })
    ) {
      throw new ResolutionError(
        ResolutionErrorCode.InvalidTwitterVerification,
        {
          domain,
        },
      );
    }

    return twitterHandle;
  }

  async reverse(
    address: string,
    currencyTicker: string,
  ): Promise<string | null> {
    throw new ResolutionError(ResolutionErrorCode.UnsupportedMethod, {
      methodName: 'reverse',
    });
  }

  async isRegistered(domain: string): Promise<boolean> {
    const tokenId = this.namehash(domain);
    const data = await this.get(tokenId, []);

    return !isNullAddress(data.owner);
  }

  async getTokenUri(tokenId: string): Promise<string> {
    const promiseL1 = this.unsl1.readerContract.call('tokenURI', [tokenId]);
    const [tokenURIL2] = await this.unsl2.readerContract
      .call('tokenURI', [tokenId])
      .catch((error) => {
        if (
          error instanceof ResolutionError &&
          error.code === ResolutionErrorCode.ServiceProviderError &&
          error.message === '< execution reverted >'
        ) {
          return [null];
        }
        throw error;
      });

    if (tokenURIL2) {
      return tokenURIL2;
    }
    const [tokenURIL1] = await promiseL1.catch((error) => {
      if (
        error instanceof ResolutionError &&
        error.code === ResolutionErrorCode.ServiceProviderError &&
        error.message === '< execution reverted >'
      ) {
        throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
          method: NamingServiceName.UNS,
          methodName: 'getTokenUri',
        });
      }
      throw error;
    });
    return tokenURIL1;
  }

  async isAvailable(domain: string): Promise<boolean> {
    return !(await this.isRegistered(domain));
  }

  async registryAddress(domainOrNamehash: string): Promise<string> {
    if (
      !this.checkDomain(domainOrNamehash, domainOrNamehash.startsWith('0x'))
    ) {
      throw new ResolutionError(ResolutionErrorCode.UnsupportedDomain, {
        domain: domainOrNamehash,
      });
    }
    const namehash = domainOrNamehash.startsWith('0x')
      ? domainOrNamehash
      : this.namehash(domainOrNamehash);
    const promiseL1 = this.unsl1.readerContract.call('registryOf', [namehash]);
    const [addressL2] = await this.unsl2.readerContract.call('registryOf', [
      namehash,
    ]);

    if (addressL2 !== NullAddress) {
      return addressL2;
    }
    const [addressL1] = await promiseL1;
    if (addressL1 !== NullAddress) {
      return addressL1;
    }
    throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
      domain: domainOrNamehash,
    });
  }

  async getDomainFromTokenId(tokenId: string): Promise<string> {
    const promiseL2 = this.unsl2.getDomainFromTokenId(tokenId);
    const promiseL1 = this.unsl1.getDomainFromTokenId(tokenId);

    const domain = await promiseL2.catch((error) => {
      if (error.code === ResolutionErrorCode.UnregisteredDomain) {
        return null;
      }
      throw error;
    });
    if (domain) {
      return domain;
    }
    return promiseL1;
  }

  async location(domain: string): Promise<DomainLocation> {
    const tokenId = this.namehash(domain);
    const [registry, {resolver, owner}] = await Promise.all([
      this.registryAddress(domain),
      this.get(tokenId),
    ]);

    return {
      registry,
      resolver,
      networkId: EthereumNetworks[this.unsl1.network],
      blockchain: BlockchainType.ETH,
      owner,
    };
  }

  private async getVerifiedData(
    domain: string,
    keys?: string[],
  ): Promise<DomainData> {
    const tokenId = this.namehash(domain);
    const data = await this.get(tokenId, keys);
    if (isNullAddress(data.resolver)) {
      if (isNullAddress(data.owner)) {
        throw new ResolutionError(ResolutionErrorCode.UnregisteredDomain, {
          domain,
        });
      }
      throw new ResolutionError(ResolutionErrorCode.UnspecifiedResolver, {
        domain,
      });
    }
    return data;
  }

  private async get(tokenId: string, keys: string[] = []): Promise<DomainData> {
    const promiseL1 = this.unsl1.readerContract.call('getData', [
      keys,
      tokenId,
    ]);
    const [resolverL2, ownerL2, recordsL2] =
      await this.unsl2.readerContract.call('getData', [keys, tokenId]);
    if (ownerL2 !== NullAddress && resolverL2 !== NullAddress) {
      return {
        resolver: resolverL2,
        owner: ownerL2,
        records: constructRecords(keys, recordsL2),
      };
    }
    const [resolverL1, ownerL1, recordsL1] = await promiseL1;
    return {
      resolver: resolverL1,
      owner: ownerL1,
      records: constructRecords(keys, recordsL1),
    };
  }

  private checkDomain(domain: string, passIfTokenID = false): boolean {
    if (passIfTokenID) {
      return true;
    }
    const tokens = domain.split('.');
    return (
      !!tokens.length &&
      tokens[tokens.length - 1] !== 'zil' &&
      !(
        domain === 'eth' ||
        /^[^-]*[^-]*\.(eth|luxe|xyz|kred|addr\.reverse)$/.test(domain)
      ) &&
      tokens.every((v) => !!v.length)
    );
  }
}

function getProxyReaderMap(): ProxyReaderMap {
  const map: ProxyReaderMap = {};
  for (const id of Object.keys(UnsConfig.networks)) {
    map[id] =
      UnsConfig.networks[id].contracts.ProxyReader.address.toLowerCase();
  }
  return map;
}
