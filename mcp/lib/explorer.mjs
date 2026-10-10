/**
 * explorer.mjs — the Explorer's own modules and data, loaded once.
 *
 * The server answers from the same code the web app runs: isaGraph.js for
 * dependencies, marchUtils.js for -march, profileExport.js for profile
 * membership. Nothing is reimplemented here, so an answer from an LLM client
 * cannot drift from what the site shows.
 *
 * Two layouts are supported. Published, `npm pack` copies those files into
 * ../explorer (scripts/bundle.mjs). In the repository, they are read straight
 * from ../../src, so tests and local runs always see the working tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packaged = join(here, '..', 'explorer');
// scripts/ is not published, so its presence means a repository checkout. A
// leftover explorer/ copy from a local `npm pack` must not shadow src/ there.
const packagedLayout = !existsSync(join(here, '..', 'scripts', 'bundle.mjs'));

export const SOURCE_DIR = packagedLayout ? packaged : join(here, '..', '..', 'src');

const load = (file) => import(pathToFileURL(join(SOURCE_DIR, file)).href);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const [isaGraph, march, profiles, profileExport, evolution, encoding, metadataUtils] =
  await Promise.all([
    load('isaGraph.js'),
    load('marchUtils.js'),
    load('profiles.js'),
    load('profileExport.js'),
    load('evolutionModel.js'),
    load('encodingUtils.js'),
    load('instructionMetadata.js'),
  ]);

const catalog = readJson(join(SOURCE_DIR, 'riscv_extensions.json'));
const instructionMetadata = readJson(join(SOURCE_DIR, 'instruction-metadata.json'));
const profileOptional = readJson(join(SOURCE_DIR, 'profile-optional.json'));
const dataVersion = packagedLayout
  ? readJson(join(packaged, 'version.json')).version
  : readJson(join(here, '..', '..', 'package.json')).version;

export const explorer = {
  catalog,
  instructionMetadata,
  profileOptional,
  dataVersion,
  graph: isaGraph.DEPENDENCY_GRAPH,
  closure: isaGraph.closure,
  resolveSelection: isaGraph.resolveSelection,
  resolveParams: isaGraph.resolveParams,
  buildMarchString: march.buildMarchString,
  parseMarchString: march.parseMarchString,
  BASE_ISA_IDS: march.BASE_ISA_IDS,
  PROFILES: profiles.PROFILES,
  PROFILE_METADATA: profiles.PROFILE_METADATA,
  profileMembership: profileExport.profileMembership,
  profileExtensionRows: profileExport.profileExtensionRows,
  CATALOGUE_GROUPS: evolution.CATALOGUE_GROUPS,
  parseHexToBigInt: encoding.parseHexToBigInt,
  toHex32: encoding.toHex32,
  instructionSynopsis: metadataUtils.instructionSynopsis,
};
