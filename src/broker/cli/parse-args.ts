export interface ParsedArgs {
  cacheDir: string
  dataDir: string
  baseUrl: string
  name: string
  command: string
  subCommand: string
  aliasArg: string
  colorArg: string
  cwdArg: string
  permissionsArg: string
  roleArg: string
  credentialIdArg: string
  notBeforeArg: string
  notAfterArg: string
  dryRun: boolean
  dbArg: string
  jsonFlag: boolean
  queryArg: string
  grantArgs: string[]
  allowRoots: string[]
  pathMapArgs: Array<{ from: string; to: string }>
  testPath: string
  destArg: string
  backupArchive: string
  includeBlobs: boolean
  retainHoursArg: string
  retainDaysArg: string
  typeArg: string
  // termination subcommand
  sourceArg: string
  initiatorArg: string
  conversationIdArg: string
  daysArg: string
  limitArg: string
  grepArg: string
}

export function parseArgs(argv: string[], defaultCacheDir: string): ParsedArgs {
  const result: ParsedArgs = {
    cacheDir: defaultCacheDir,
    dataDir: '',
    baseUrl: 'http://localhost:9999',
    name: '',
    command: '',
    subCommand: '',
    aliasArg: '',
    colorArg: '',
    cwdArg: '',
    permissionsArg: '',
    roleArg: '',
    credentialIdArg: '',
    notBeforeArg: '',
    notAfterArg: '',
    dryRun: false,
    dbArg: '',
    jsonFlag: false,
    queryArg: '',
    grantArgs: [],
    allowRoots: [],
    pathMapArgs: [],
    testPath: '',
    destArg: '',
    backupArchive: '',
    includeBlobs: false,
    retainHoursArg: '',
    retainDaysArg: '',
    typeArg: '',
    sourceArg: '',
    initiatorArg: '',
    conversationIdArg: '',
    daysArg: '',
    limitArg: '',
    grepArg: '',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--cache-dir') {
      result.cacheDir = argv[++i]
    } else if (arg === '--data-dir') {
      result.dataDir = argv[++i]
    } else if (arg === '--dry-run') {
      result.dryRun = true
    } else if (arg === '--url') {
      result.baseUrl = argv[++i]
    } else if (arg === '--name') {
      result.name = argv[++i]
    } else if (arg === '--grant') {
      result.grantArgs.push(argv[++i])
    } else if (arg === '--scope' || arg === '--cwd') {
      result.cwdArg = argv[++i]
    } else if (arg === '--permissions') {
      result.permissionsArg = argv[++i]
    } else if (arg === '--role') {
      result.roleArg = argv[++i]
    } else if (arg === '--alias') {
      result.aliasArg = argv[++i]
    } else if (arg === '--color') {
      result.colorArg = argv[++i]
    } else if (arg === '--credential-id') {
      result.credentialIdArg = argv[++i]
    } else if (arg === '--not-before') {
      result.notBeforeArg = argv[++i]
    } else if (arg === '--not-after') {
      result.notAfterArg = argv[++i]
    } else if (arg === '--allow-root') {
      result.allowRoots.push(argv[++i])
    } else if (arg === '--path-map') {
      const mapping = argv[++i]
      const sep = mapping.indexOf(':')
      if (sep > 0) {
        result.pathMapArgs.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) })
      }
    } else if (arg === '--db') {
      result.dbArg = argv[++i]
    } else if (arg === '--json') {
      result.jsonFlag = true
    } else if (arg === '--dest') {
      result.destArg = argv[++i]
    } else if (arg === '--include-blobs') {
      result.includeBlobs = true
    } else if (arg === '--retain-hours') {
      result.retainHoursArg = argv[++i]
    } else if (arg === '--retain-days') {
      result.retainDaysArg = argv[++i]
    } else if (arg === '--type') {
      result.typeArg = argv[++i]
    } else if (arg === '--source') {
      result.sourceArg = argv[++i]
    } else if (arg === '--initiator') {
      result.initiatorArg = argv[++i]
    } else if (arg === '--conversation' || arg === '--conv') {
      result.conversationIdArg = argv[++i]
    } else if (arg === '--days') {
      result.daysArg = argv[++i]
    } else if (arg === '--limit') {
      result.limitArg = argv[++i]
    } else if (arg === '--grep') {
      result.grepArg = argv[++i]
    } else if (!arg.startsWith('-')) {
      if (result.command === 'resolve-path' && !result.testPath) {
        result.testPath = arg
      } else if ((result.command === 'query' || result.command === 'exec') && !result.queryArg) {
        result.queryArg = arg
      } else if (result.command === 'sentinel' && !result.subCommand) {
        result.subCommand = arg
      } else if (result.command === 'gateway' && !result.subCommand) {
        result.subCommand = arg
      } else if (result.command === 'backup' && !result.subCommand) {
        result.subCommand = arg
      } else if (result.command === 'backup' && result.subCommand === 'restore' && !result.backupArchive) {
        result.backupArchive = arg
      } else if (result.command === 'termination' && !result.subCommand) {
        result.subCommand = arg
      } else if (result.command === 'termination' && result.subCommand === 'grep' && !result.grepArg) {
        result.grepArg = arg
      } else {
        result.command = arg
      }
    }
  }

  return result
}
