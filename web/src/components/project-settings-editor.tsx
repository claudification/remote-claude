import {
  Activity,
  AirVent,
  AlertTriangle,
  Anchor,
  Anvil,
  Apple,
  Archive,
  Armchair,
  AtSign,
  Award,
  Axe,
  Banana,
  Banknote,
  BarChart3,
  Barrel,
  Bath,
  Bed,
  Beer,
  Bell,
  Bike,
  Binary,
  Bird,
  Blocks,
  Bone,
  Bookmark,
  Bot,
  BotMessageSquare,
  Box,
  Braces,
  Brain,
  BrainCircuit,
  BrainCog,
  Briefcase,
  Bug,
  Building2,
  Cake,
  Calendar,
  Camera,
  Candy,
  Carrot,
  Cast,
  Cat,
  Check,
  Cherry,
  Church,
  CircleUser,
  CircuitBoard,
  Citrus,
  Clipboard,
  Clock,
  Cloud,
  CloudCog,
  Code,
  Coffee,
  Cog,
  Coins,
  Compass,
  Construction,
  Contact,
  Container,
  Cookie,
  Cpu,
  CreditCard,
  Croissant,
  Crown,
  CupSoda,
  Database,
  Dice1,
  Dog,
  DollarSign,
  Donut,
  DoorOpen,
  Download,
  Drama,
  Drill,
  Droplet,
  Drumstick,
  Dumbbell,
  Ear,
  Egg,
  Eye,
  Factory,
  Fan,
  Feather,
  Fence,
  FileCode,
  FileJson,
  FileScan,
  FileText,
  Fingerprint,
  Fish,
  Flag,
  Flame,
  Folder,
  Footprints,
  Forklift,
  Fuel,
  Gamepad2,
  Gem,
  Gift,
  GitBranch,
  GitCommit,
  GitCompare,
  GitFork,
  GitMerge,
  GitPullRequest,
  Glasses,
  GlassWater,
  Globe,
  GraduationCap,
  Grape,
  Ham,
  Hamburger,
  Hammer,
  Hand,
  HandCoins,
  HandMetal,
  Handshake,
  HardDrive,
  Hash,
  Headphones,
  Heart,
  HeartPulse,
  Home,
  Hospital,
  HousePlug,
  IceCreamCone,
  Image,
  Infinity as InfinityIcon,
  Key,
  Lamp,
  LampDesk,
  Laugh,
  Layers,
  Leaf,
  Library,
  Lightbulb,
  Link,
  Lock,
  Lollipop,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  Martini,
  Megaphone,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Microwave,
  Milk,
  Monitor,
  Moon,
  Mountain,
  Music,
  Navigation,
  Network,
  Notebook,
  NotebookPen,
  Package,
  Palette,
  Paperclip,
  PawPrint,
  Pencil,
  PencilRuler,
  PenTool,
  PersonStanding,
  Phone,
  PiggyBank,
  Pill,
  Pizza,
  Plane,
  Plug,
  Popcorn,
  Printer,
  Radio,
  Rainbow,
  Receipt,
  Refrigerator,
  Regex,
  Rocket,
  Rss,
  Ruler,
  Sailboat,
  Salad,
  Sandwich,
  Scan,
  ScanBarcode,
  School,
  Scissors,
  Search,
  Send,
  Server,
  ServerCog,
  Settings,
  Share2,
  Shield,
  ShoppingCart,
  Shovel,
  Skull,
  Smartphone,
  SmilePlus,
  Sofa,
  Soup,
  Sparkle,
  Sparkles,
  Speaker,
  SquareCode,
  Squirrel,
  Stamp,
  Star,
  Stethoscope,
  Store,
  Sun,
  Swords,
  Tag,
  Target,
  Tent,
  Terminal,
  TestTube2,
  Thermometer,
  Tornado,
  Tractor,
  TrainFront,
  Trash2,
  TreePine,
  Truck,
  Turtle,
  TvMinimal,
  Umbrella,
  University,
  Upload,
  User,
  UserCircle,
  UserRound,
  Users,
  UsersRound,
  UtensilsCrossed,
  Variable,
  Video,
  Volume2,
  Wallet,
  WalletCards,
  WandSparkles,
  Warehouse,
  WashingMachine,
  Watch,
  Wheat,
  Wifi,
  Wind,
  Wine,
  Workflow,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { PermissionRulesEditor } from '@/components/settings/permission-rules-editor'
import { GroupHeader, SettingRow } from '@/components/settings/settings-inputs'
import { SettingsShell, type SettingsShellTab } from '@/components/settings/settings-shell'
import {
  deleteProjectSettings,
  generateProjectKeyterms,
  updateProjectSettings,
  useConversationsStore,
} from '@/hooks/use-sessions'
import { extractProjectLabel, type ProjectSettings } from '@/lib/types'
import { cn } from '@/lib/utils'

interface IconEntry {
  id: string
  icon: LucideIcon
  keywords: string // space-separated search terms
}

// Comprehensive icon library with search keywords
const ICONS: IconEntry[] = [
  { id: 'globe', icon: Globe, keywords: 'globe world web internet earth' },
  { id: 'rocket', icon: Rocket, keywords: 'rocket launch deploy ship fast' },
  { id: 'settings', icon: Settings, keywords: 'settings gear config cog preferences' },
  { id: 'wrench', icon: Wrench, keywords: 'wrench tool fix repair maintain' },
  { id: 'package', icon: Package, keywords: 'package npm box bundle module' },
  { id: 'plug', icon: Plug, keywords: 'plug connect plugin integration api' },
  { id: 'lock', icon: Lock, keywords: 'lock security auth password private' },
  { id: 'chart', icon: BarChart3, keywords: 'chart bar graph analytics stats data' },
  { id: 'target', icon: Target, keywords: 'target goal focus aim crosshair' },
  { id: 'zap', icon: Zap, keywords: 'zap lightning bolt fast energy power electric' },
  { id: 'flame', icon: Flame, keywords: 'flame fire hot trending popular burn' },
  { id: 'star', icon: Star, keywords: 'star favorite rating important featured' },
  { id: 'gem', icon: Gem, keywords: 'gem diamond ruby precious valuable' },
  { id: 'bot', icon: Bot, keywords: 'bot robot ai machine learning claude agent' },
  { id: 'test', icon: TestTube2, keywords: 'test tube lab experiment science research' },
  { id: 'file', icon: FileText, keywords: 'file text document page note' },
  { id: 'home', icon: Home, keywords: 'home house main landing root' },
  { id: 'factory', icon: Factory, keywords: 'factory build manufacturing ci cd pipeline' },
  { id: 'hammer', icon: Hammer, keywords: 'hammer build construct tool make' },
  { id: 'database', icon: Database, keywords: 'database db sql postgres mysql storage' },
  { id: 'server', icon: Server, keywords: 'server backend host infrastructure rack' },
  { id: 'shield', icon: Shield, keywords: 'shield security protect guard defense safe' },
  { id: 'code', icon: Code, keywords: 'code bracket dev programming html' },
  { id: 'terminal', icon: Terminal, keywords: 'terminal console cli shell bash command prompt' },
  { id: 'cloud', icon: Cloud, keywords: 'cloud aws azure gcp hosting saas' },
  { id: 'coffee', icon: Coffee, keywords: 'coffee java cup drink cafe mug' },
  { id: 'bug', icon: Bug, keywords: 'bug insect debug error issue defect' },
  { id: 'layers', icon: Layers, keywords: 'layers stack tier level architecture' },
  { id: 'git', icon: GitBranch, keywords: 'git branch version control merge' },
  { id: 'heart', icon: Heart, keywords: 'heart love favorite like health' },
  { id: 'monitor', icon: Monitor, keywords: 'monitor screen display desktop frontend' },
  { id: 'phone', icon: Smartphone, keywords: 'phone smartphone mobile ios android app' },
  { id: 'wifi', icon: Wifi, keywords: 'wifi wireless network connection signal' },
  { id: 'key', icon: Key, keywords: 'key auth token secret credential' },
  { id: 'eye', icon: Eye, keywords: 'eye view watch observe monitor visible' },
  { id: 'bell', icon: Bell, keywords: 'bell notification alert alarm ring' },
  { id: 'camera', icon: Camera, keywords: 'camera photo image picture snapshot' },
  { id: 'music', icon: Music, keywords: 'music audio sound note melody' },
  { id: 'image', icon: Image, keywords: 'image photo picture media visual' },
  { id: 'video', icon: Video, keywords: 'video film movie recording stream' },
  { id: 'folder', icon: Folder, keywords: 'folder directory file system organize' },
  { id: 'archive', icon: Archive, keywords: 'archive zip compress backup store' },
  { id: 'download', icon: Download, keywords: 'download save fetch get pull' },
  { id: 'upload', icon: Upload, keywords: 'upload push deploy publish send' },
  { id: 'send', icon: Send, keywords: 'send message dispatch notify submit' },
  { id: 'mail', icon: Mail, keywords: 'mail email letter message envelope' },
  { id: 'calendar', icon: Calendar, keywords: 'calendar date schedule event plan' },
  { id: 'clock', icon: Clock, keywords: 'clock time timer schedule wait' },
  { id: 'map', icon: MapIcon, keywords: 'map location geography place route' },
  { id: 'navigation', icon: Navigation, keywords: 'navigation direction compass arrow guide' },
  { id: 'compass', icon: Compass, keywords: 'compass direction explore navigate discover' },
  { id: 'anchor', icon: Anchor, keywords: 'anchor dock port harbor stable' },
  { id: 'cpu', icon: Cpu, keywords: 'cpu chip processor hardware compute' },
  { id: 'harddrive', icon: HardDrive, keywords: 'hard drive disk storage ssd' },
  { id: 'activity', icon: Activity, keywords: 'activity pulse heartbeat monitor health' },
  { id: 'alert', icon: AlertTriangle, keywords: 'alert warning danger caution error' },
  { id: 'award', icon: Award, keywords: 'award trophy prize medal badge' },
  { id: 'bookmark', icon: Bookmark, keywords: 'bookmark save mark flag reference' },
  { id: 'box', icon: Box, keywords: 'box container cube 3d' },
  { id: 'briefcase', icon: Briefcase, keywords: 'briefcase business work corporate job' },
  { id: 'clipboard', icon: Clipboard, keywords: 'clipboard paste copy notes task' },
  { id: 'cog', icon: Cog, keywords: 'cog gear settings config mechanical' },
  { id: 'crown', icon: Crown, keywords: 'crown king queen royal premium' },
  { id: 'dice', icon: Dice1, keywords: 'dice game random chance play' },
  { id: 'dollar', icon: DollarSign, keywords: 'dollar money payment billing finance' },
  { id: 'feather', icon: Feather, keywords: 'feather light write pen quill' },
  { id: 'flag', icon: Flag, keywords: 'flag mark milestone important checkpoint' },
  { id: 'gift', icon: Gift, keywords: 'gift present surprise reward bonus' },
  { id: 'headphones', icon: Headphones, keywords: 'headphones audio listen music podcast' },
  { id: 'infinity', icon: InfinityIcon, keywords: 'infinity loop endless forever eternal' },
  { id: 'lightbulb', icon: Lightbulb, keywords: 'lightbulb idea innovation creative bright' },
  { id: 'link', icon: Link, keywords: 'link chain url connection reference' },
  { id: 'chat', icon: MessageCircle, keywords: 'chat message bubble conversation talk' },
  { id: 'moon', icon: Moon, keywords: 'moon night dark theme sleep' },
  { id: 'sun', icon: Sun, keywords: 'sun day light bright theme' },
  { id: 'palette', icon: Palette, keywords: 'palette art color design paint' },
  { id: 'pen', icon: PenTool, keywords: 'pen tool draw design vector' },
  { id: 'telephone', icon: Phone, keywords: 'telephone phone call voice ring' },
  { id: 'printer', icon: Printer, keywords: 'printer print output document paper' },
  { id: 'radio', icon: Radio, keywords: 'radio broadcast signal frequency' },
  { id: 'scissors', icon: Scissors, keywords: 'scissors cut trim clip snip' },
  { id: 'share', icon: Share2, keywords: 'share social distribute spread forward' },
  { id: 'cart', icon: ShoppingCart, keywords: 'cart shopping store ecommerce buy' },
  { id: 'chat2', icon: MessageCircle, keywords: 'slack chat team communication channel' },
  { id: 'speaker', icon: Speaker, keywords: 'speaker audio sound volume loud' },
  { id: 'swords', icon: Swords, keywords: 'swords fight battle game combat' },
  { id: 'tag', icon: Tag, keywords: 'tag label price category classify' },
  { id: 'thermometer', icon: Thermometer, keywords: 'thermometer temperature weather hot cold' },
  { id: 'truck', icon: Truck, keywords: 'truck delivery shipping transport logistics' },
  { id: 'umbrella', icon: Umbrella, keywords: 'umbrella rain weather protect cover' },
  { id: 'users', icon: Users, keywords: 'users team people group community' },
  { id: 'volume', icon: Volume2, keywords: 'volume sound audio speaker loud' },
  { id: 'watch', icon: Watch, keywords: 'watch time wearable clock schedule' },
  { id: 'wind', icon: Wind, keywords: 'wind air breeze weather flow' },
  { id: 'gamepad', icon: Gamepad2, keywords: 'gamepad game controller play fun' },
  { id: 'leaf', icon: Leaf, keywords: 'leaf nature plant eco green organic' },
  { id: 'search', icon: Search, keywords: 'search find magnify look discover' },
  // People & faces
  { id: 'user', icon: User, keywords: 'user person human profile account' },
  { id: 'user-circle', icon: UserCircle, keywords: 'user circle avatar profile face' },
  { id: 'user-round', icon: UserRound, keywords: 'user round avatar person face head' },
  { id: 'circle-user', icon: CircleUser, keywords: 'circle user face avatar person portrait' },
  { id: 'users-round', icon: UsersRound, keywords: 'users people team group faces crew' },
  { id: 'person', icon: PersonStanding, keywords: 'person standing human body figure' },
  { id: 'smile', icon: SmilePlus, keywords: 'smile face happy emoji smiley joy' },
  { id: 'laugh', icon: Laugh, keywords: 'laugh face happy funny lol joy' },
  { id: 'drama', icon: Drama, keywords: 'drama masks theater comedy tragedy face' },
  { id: 'skull', icon: Skull, keywords: 'skull death danger pirate bones' },
  { id: 'glasses', icon: Glasses, keywords: 'glasses nerd smart vision eye wear' },
  { id: 'graduation', icon: GraduationCap, keywords: 'graduation cap school education degree student' },
  { id: 'handshake', icon: Handshake, keywords: 'handshake deal agreement partnership meeting' },
  { id: 'hand', icon: Hand, keywords: 'hand wave hello stop gesture palm' },
  { id: 'hand-metal', icon: HandMetal, keywords: 'hand metal rock horns gesture punk' },
  { id: 'fingerprint', icon: Fingerprint, keywords: 'fingerprint identity biometric auth security scan' },
  { id: 'ear', icon: Ear, keywords: 'ear listen hear audio voice sound' },
  { id: 'footprints', icon: Footprints, keywords: 'footprints walk track trail path steps' },
  { id: 'brain', icon: Brain, keywords: 'brain mind think intelligence smart ai' },
  // Animals
  { id: 'cat', icon: Cat, keywords: 'cat kitten pet animal meow feline' },
  { id: 'dog', icon: Dog, keywords: 'dog puppy pet animal bark canine' },
  { id: 'bird', icon: Bird, keywords: 'bird fly tweet wing feather' },
  { id: 'fish', icon: Fish, keywords: 'fish aqua water swim ocean marine' },
  { id: 'squirrel', icon: Squirrel, keywords: 'squirrel animal cute woodland nature' },
  { id: 'turtle', icon: Turtle, keywords: 'turtle slow shell reptile steady' },
  { id: 'paw', icon: PawPrint, keywords: 'paw print animal pet dog cat track' },
  { id: 'bone', icon: Bone, keywords: 'bone dog skeleton pet treat' },
  // Food & drink
  { id: 'pizza', icon: Pizza, keywords: 'pizza food slice lunch dinner eat' },
  { id: 'cookie', icon: Cookie, keywords: 'cookie snack biscuit sweet treat' },
  { id: 'wine', icon: Wine, keywords: 'wine glass drink alcohol celebration cheers' },
  { id: 'citrus', icon: Citrus, keywords: 'citrus lemon orange fruit juice fresh' },
  { id: 'utensils', icon: UtensilsCrossed, keywords: 'utensils fork knife food eat restaurant dinner' },
  // Nature & places
  { id: 'mountain', icon: Mountain, keywords: 'mountain peak summit nature outdoor climb' },
  { id: 'tree', icon: TreePine, keywords: 'tree pine forest nature wood' },
  { id: 'rainbow', icon: Rainbow, keywords: 'rainbow color pride spectrum arc' },
  { id: 'tornado', icon: Tornado, keywords: 'tornado storm wind disaster vortex' },
  { id: 'sparkles', icon: Sparkles, keywords: 'sparkles magic shine glitter ai new' },
  // Buildings & transport
  { id: 'store', icon: Store, keywords: 'store shop retail market business ecommerce' },
  { id: 'school', icon: School, keywords: 'school education building learn academy' },
  { id: 'library', icon: Library, keywords: 'library books knowledge education reading' },
  { id: 'university', icon: University, keywords: 'university college campus education institution' },
  { id: 'church', icon: Church, keywords: 'church chapel temple religion worship' },
  { id: 'hospital', icon: Hospital, keywords: 'hospital medical health clinic care' },
  { id: 'construction', icon: Construction, keywords: 'construction build work progress crane' },
  { id: 'plane', icon: Plane, keywords: 'plane airplane flight travel airport' },
  { id: 'train', icon: TrainFront, keywords: 'train rail transit metro subway' },
  { id: 'sailboat', icon: Sailboat, keywords: 'sailboat boat yacht sea ocean sailing' },
  { id: 'bike', icon: Bike, keywords: 'bike bicycle cycle ride pedal' },
  { id: 'tent', icon: Tent, keywords: 'tent camping outdoor adventure wilderness' },
  // Health & fitness
  { id: 'heartpulse', icon: HeartPulse, keywords: 'heart pulse health vital alive beat' },
  { id: 'stethoscope', icon: Stethoscope, keywords: 'stethoscope doctor medical health checkup' },
  { id: 'pill', icon: Pill, keywords: 'pill medicine drug pharmacy health' },
  { id: 'dumbbell', icon: Dumbbell, keywords: 'dumbbell fitness gym workout exercise strength' },
  // Home & furniture
  { id: 'sofa', icon: Sofa, keywords: 'sofa couch living room furniture lounge seat' },
  { id: 'armchair', icon: Armchair, keywords: 'armchair chair seat furniture comfort' },
  { id: 'bed', icon: Bed, keywords: 'bed sleep bedroom furniture rest hotel' },
  { id: 'lamp', icon: Lamp, keywords: 'lamp light table bedside glow' },
  { id: 'lamp-desk', icon: LampDesk, keywords: 'lamp desk office light work study' },
  { id: 'bath', icon: Bath, keywords: 'bath tub bathroom shower water clean' },
  { id: 'door', icon: DoorOpen, keywords: 'door open entrance entry exit room' },
  { id: 'fence', icon: Fence, keywords: 'fence yard garden boundary perimeter' },
  { id: 'tv', icon: TvMinimal, keywords: 'tv television screen media watch display' },
  { id: 'air-vent', icon: AirVent, keywords: 'air vent hvac cooling heating ventilation' },
  { id: 'fan', icon: Fan, keywords: 'fan cooling breeze air spin rotate' },
  { id: 'washing-machine', icon: WashingMachine, keywords: 'washing machine laundry clean clothes appliance' },
  { id: 'microwave', icon: Microwave, keywords: 'microwave oven kitchen heat cook appliance' },
  { id: 'refrigerator', icon: Refrigerator, keywords: 'refrigerator fridge cold freezer kitchen food' },
  { id: 'house-plug', icon: HousePlug, keywords: 'house plug smart home energy electric power' },
  // Office & supplies
  { id: 'paperclip', icon: Paperclip, keywords: 'paperclip attach clip office supply paper' },
  { id: 'stamp', icon: Stamp, keywords: 'stamp seal approve official mark postal' },
  { id: 'ruler', icon: Ruler, keywords: 'ruler measure length size dimension' },
  { id: 'pencil-ruler', icon: PencilRuler, keywords: 'pencil ruler design draft blueprint measure' },
  { id: 'notebook', icon: Notebook, keywords: 'notebook journal notes writing pad diary' },
  { id: 'notebook-pen', icon: NotebookPen, keywords: 'notebook pen write journal log diary' },
  { id: 'scan', icon: Scan, keywords: 'scan document copy digitize capture' },
  { id: 'scan-barcode', icon: ScanBarcode, keywords: 'scan barcode inventory product upc price' },
  { id: 'file-scan', icon: FileScan, keywords: 'file scan document ocr digitize' },
  // Finance & billing
  { id: 'wallet', icon: Wallet, keywords: 'wallet money payment billing account' },
  { id: 'wallet-cards', icon: WalletCards, keywords: 'wallet cards payment credit debit bank' },
  { id: 'credit-card', icon: CreditCard, keywords: 'credit card payment stripe billing charge' },
  { id: 'banknote', icon: Banknote, keywords: 'banknote cash money bill payment currency' },
  { id: 'receipt', icon: Receipt, keywords: 'receipt invoice bill transaction purchase' },
  { id: 'coins', icon: Coins, keywords: 'coins money change currency crypto token' },
  { id: 'piggy-bank', icon: PiggyBank, keywords: 'piggy bank savings invest money fund budget' },
  { id: 'hand-coins', icon: HandCoins, keywords: 'hand coins pay tip donate give money' },
  // Industrial & raw materials
  { id: 'fuel', icon: Fuel, keywords: 'fuel gas diesel petrol pump station energy' },
  { id: 'barrel', icon: Barrel, keywords: 'barrel oil drum container crude petroleum' },
  { id: 'droplet', icon: Droplet, keywords: 'droplet water oil liquid fluid wet' },
  { id: 'drill', icon: Drill, keywords: 'drill bore tool power construction mining' },
  { id: 'container', icon: Container, keywords: 'container shipping cargo freight dock port' },
  { id: 'forklift', icon: Forklift, keywords: 'forklift warehouse lift load heavy industrial' },
  { id: 'warehouse', icon: Warehouse, keywords: 'warehouse storage depot distribution logistics' },
  { id: 'building', icon: Building2, keywords: 'building office tower city urban corporate' },
  { id: 'anvil', icon: Anvil, keywords: 'anvil forge smith metal craft blacksmith' },
  { id: 'axe', icon: Axe, keywords: 'axe chop wood lumber forest tool' },
  { id: 'shovel', icon: Shovel, keywords: 'shovel dig earth garden construction ground' },
  { id: 'tractor', icon: Tractor, keywords: 'tractor farm agriculture field crop harvest' },
  { id: 'wheat', icon: Wheat, keywords: 'wheat grain crop agriculture farm harvest food' },
  // More food & drink
  { id: 'apple', icon: Apple, keywords: 'apple fruit healthy snack food red green' },
  { id: 'banana', icon: Banana, keywords: 'banana fruit tropical yellow snack' },
  { id: 'cherry', icon: Cherry, keywords: 'cherry fruit berry sweet red pair' },
  { id: 'grape', icon: Grape, keywords: 'grape fruit vine wine purple cluster' },
  { id: 'carrot', icon: Carrot, keywords: 'carrot vegetable orange healthy garden food' },
  { id: 'egg', icon: Egg, keywords: 'egg breakfast food chicken oval' },
  { id: 'sandwich', icon: Sandwich, keywords: 'sandwich lunch bread sub deli food' },
  { id: 'soup', icon: Soup, keywords: 'soup bowl hot warm meal comfort food' },
  { id: 'salad', icon: Salad, keywords: 'salad greens healthy vegetable bowl food' },
  { id: 'hamburger', icon: Hamburger, keywords: 'hamburger burger fast food beef bun' },
  { id: 'ham', icon: Ham, keywords: 'ham meat pork leg roast food' },
  { id: 'drumstick', icon: Drumstick, keywords: 'drumstick chicken leg meat poultry food' },
  { id: 'croissant', icon: Croissant, keywords: 'croissant pastry bread french bakery' },
  { id: 'popcorn', icon: Popcorn, keywords: 'popcorn snack movie cinema theater' },
  { id: 'cake', icon: Cake, keywords: 'cake birthday celebration dessert sweet party' },
  { id: 'ice-cream', icon: IceCreamCone, keywords: 'ice cream cone dessert sweet cold treat' },
  { id: 'candy', icon: Candy, keywords: 'candy sweet sugar treat confection' },
  { id: 'lollipop', icon: Lollipop, keywords: 'lollipop candy sweet sugar stick treat' },
  { id: 'donut', icon: Donut, keywords: 'donut doughnut pastry sweet ring fried' },
  { id: 'beer', icon: Beer, keywords: 'beer brew ale lager pub drink hops' },
  { id: 'martini', icon: Martini, keywords: 'martini cocktail drink bar lounge vodka gin' },
  { id: 'milk', icon: Milk, keywords: 'milk dairy drink cream white bottle' },
  { id: 'cup-soda', icon: CupSoda, keywords: 'cup soda pop drink beverage straw fizz' },
  { id: 'glass-water', icon: GlassWater, keywords: 'glass water drink hydrate clear clean' },
  // AI & ML
  { id: 'brain-circuit', icon: BrainCircuit, keywords: 'brain circuit ai neural network machine learning' },
  { id: 'brain-cog', icon: BrainCog, keywords: 'brain cog ai settings neural config thinking' },
  { id: 'wand', icon: WandSparkles, keywords: 'wand magic sparkles generate ai transform' },
  { id: 'sparkle', icon: Sparkle, keywords: 'sparkle shine glitter new ai magic' },
  { id: 'circuit-board', icon: CircuitBoard, keywords: 'circuit board hardware pcb electronics chip' },
  { id: 'workflow', icon: Workflow, keywords: 'workflow pipeline process flow automation steps' },
  { id: 'network', icon: Network, keywords: 'network graph nodes mesh topology connections' },
  { id: 'bot-message', icon: BotMessageSquare, keywords: 'bot message chat ai assistant agent' },
  // More dev tools
  { id: 'git-commit', icon: GitCommit, keywords: 'git commit save checkpoint point' },
  { id: 'git-compare', icon: GitCompare, keywords: 'git compare diff review changes' },
  { id: 'git-fork', icon: GitFork, keywords: 'git fork branch split clone' },
  { id: 'git-merge', icon: GitMerge, keywords: 'git merge join combine branch' },
  { id: 'git-pr', icon: GitPullRequest, keywords: 'git pull request pr review merge' },
  { id: 'server-cog', icon: ServerCog, keywords: 'server cog config ops infrastructure manage' },
  { id: 'cloud-cog', icon: CloudCog, keywords: 'cloud cog config devops infrastructure settings' },
  { id: 'container-dev', icon: Container, keywords: 'container docker ship deploy devops kubernetes' },
  { id: 'blocks', icon: Blocks, keywords: 'blocks components modules puzzle build lego' },
  { id: 'regex', icon: Regex, keywords: 'regex pattern match search expression filter' },
  { id: 'square-code', icon: SquareCode, keywords: 'code square embed snippet widget component' },
  { id: 'file-code', icon: FileCode, keywords: 'file code source script program module' },
  { id: 'file-json', icon: FileJson, keywords: 'file json data config settings api' },
  { id: 'variable', icon: Variable, keywords: 'variable math formula equation parameter' },
  { id: 'binary', icon: Binary, keywords: 'binary code bits data low level byte' },
  { id: 'braces', icon: Braces, keywords: 'braces curly bracket json object code' },
  { id: 'hash', icon: Hash, keywords: 'hash pound number tag channel' },
  // Communication
  { id: 'message-square', icon: MessageSquare, keywords: 'message square chat text bubble' },
  { id: 'messages', icon: MessagesSquare, keywords: 'messages conversation thread discussion group' },
  { id: 'at-sign', icon: AtSign, keywords: 'at sign email mention handle address' },
  { id: 'megaphone', icon: Megaphone, keywords: 'megaphone announce broadcast shout promote' },
  { id: 'rss', icon: Rss, keywords: 'rss feed subscribe news blog updates' },
  { id: 'cast', icon: Cast, keywords: 'cast stream broadcast chromecast airplay' },
  { id: 'contact', icon: Contact, keywords: 'contact person card vcard address book' },
]

const ICON_MAP: Record<string, IconEntry> = Object.fromEntries(ICONS.map(e => [e.id, e]))

export function renderProjectIcon(iconId: string, className = 'w-3.5 h-3.5') {
  const entry = ICON_MAP[iconId]
  if (!entry) return null
  const Icon = entry.icon
  return <Icon className={className} />
}

// Color palette - works on dark bg
const COLOR_OPTIONS = [
  '', // none/default
  '#7aa2f7', // blue (accent)
  '#9ece6a', // green
  '#e0af68', // amber
  '#f7768e', // red/pink
  '#bb9af7', // purple
  '#7dcfff', // cyan
  '#ff9e64', // orange
  '#c0caf5', // light blue/white
  '#73daca', // teal
  '#db4b4b', // dark red
]

interface ProjectSettingsEditorProps {
  project: string
  onClose: () => void
}

const PROJECT_TABS: SettingsShellTab[] = [
  { id: 'general', label: 'General' },
  { id: 'launch', label: 'Launch' },
  { id: 'security', label: 'Security' },
]

export function ProjectSettingsEditor({ project, onClose }: ProjectSettingsEditorProps) {
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const setProjectSettings = useConversationsStore(s => s.setProjectSettings)
  const current = projectSettings[project] || {}

  const [activeTab, setActiveTab] = useState('general')
  const [label, setLabel] = useState(current.label || '')
  const [icon, setIcon] = useState(current.icon || '')
  const [color, setColor] = useState(current.color || '')
  const [description, setDescription] = useState(current.description || '')
  const [keyterms, setKeyterms] = useState<string[]>(current.keyterms || [])
  const [trustLevel, setTrustLevel] = useState<string>(current.trustLevel || 'default')
  const [launchMode, setLaunchMode] = useState<string>(current.defaultLaunchMode || 'headless')
  const [effort, setEffort] = useState<string>(current.defaultEffort || 'default')
  const [model, setModel] = useState<string>(current.defaultModel || '')
  const [keytermInput, setKeytermInput] = useState('')
  const [iconSearch, setIconSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  useEffect(() => {
    const c = projectSettings[project] || {}
    setLabel(c.label || '')
    setIcon(c.icon || '')
    setColor(c.color || '')
    setDescription(c.description || '')
    setKeyterms(c.keyterms || [])
    setTrustLevel(c.trustLevel || 'default')
    setLaunchMode(c.defaultLaunchMode || 'headless')
    setEffort(c.defaultEffort || 'default')
  }, [projectSettings, project])

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return ICONS
    const q = iconSearch.toLowerCase().trim()
    return ICONS.filter(e => e.id.includes(q) || e.keywords.includes(q))
  }, [iconSearch])

  async function handleSave() {
    setSaving(true)
    const settings: ProjectSettings = {
      label: label.trim() || '',
      icon: icon || '',
      color: color || '',
      description: description.trim() || '',
      keyterms: keyterms.length ? keyterms : [],
      trustLevel: trustLevel === 'default' ? undefined : (trustLevel as 'open' | 'benevolent'),
      defaultLaunchMode: launchMode === 'headless' ? undefined : (launchMode as 'pty'),
      defaultEffort: effort === 'default' ? undefined : (effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'),
      defaultModel: model.trim() || undefined,
    }
    updateProjectSettings(project, settings)
    setSaving(false)
    onClose()
  }

  async function handleGenerateKeyterms() {
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateProjectKeyterms(project)
      if (result) {
        setKeyterms(result.keyterms)
        setProjectSettings(result.settings)
      }
    } catch (err: unknown) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate')
    }
    setGenerating(false)
  }

  function addKeyterm() {
    const term = keytermInput.trim()
    if (term && !keyterms.includes(term)) {
      setKeyterms([...keyterms, term])
      setKeytermInput('')
    }
  }

  function removeKeyterm(term: string) {
    setKeyterms(keyterms.filter(t => t !== term))
  }

  function handleClear() {
    setSaving(true)
    deleteProjectSettings(project)
    setSaving(false)
    onClose()
  }

  const hasChanges =
    label.trim() !== (current.label || '') ||
    icon !== (current.icon || '') ||
    color !== (current.color || '') ||
    description.trim() !== (current.description || '') ||
    JSON.stringify(keyterms) !== JSON.stringify(current.keyterms || []) ||
    trustLevel !== (current.trustLevel || 'default') ||
    launchMode !== (current.defaultLaunchMode || 'headless') ||
    effort !== (current.defaultEffort || 'default') ||
    model.trim() !== (current.defaultModel || '')

  const hasAnySettings =
    current.label ||
    current.icon ||
    current.color ||
    current.description ||
    (current.keyterms?.length ?? 0) > 0 ||
    current.trustLevel

  return (
    <SettingsShell
      open
      onOpenChange={v => {
        if (!v) onClose()
      }}
      title="Project Configuration"
      tabs={PROJECT_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      maxWidth="md"
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border transition-colors',
              hasChanges
                ? 'border-accent bg-accent/20 text-accent hover:bg-accent/30'
                : 'border-border text-muted-foreground cursor-not-allowed',
            )}
          >
            <Check className="w-3 h-3" />
            Save
          </button>
          {hasAnySettings && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-red-500/50 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Reset All
            </button>
          )}
        </div>
      }
    >
      <div className="text-xs space-y-3">
        {/* ── General tab ──────────────────────────────────────────── */}
        {activeTab === 'general' && (
          <>
            <div className="text-[10px] text-muted-foreground/60 font-mono truncate mb-2" title={project}>
              {project}
            </div>
            <GroupHeader label="Identity" />
            <SettingRow label="Label" description="Display name for this project">
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={extractProjectLabel(project) || 'project name'}
                className="w-40 bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </SettingRow>

            <div>
              <SettingRow label="Description" description="Visible to other sessions via list_sessions">
                <span />
              </SettingRow>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g. Send all music generation requests here"
                rows={2}
                className="w-full bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50 resize-none mt-1"
                style={{ fontSize: '16px' }}
              />
            </div>

            <GroupHeader label="Appearance" />

            {/* Icon picker */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Icon</div>
              <div className="relative mb-1.5">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={iconSearch}
                  onChange={e => setIconSearch(e.target.value)}
                  placeholder="Search icons..."
                  className="w-full bg-background border border-border pl-6 pr-2 py-1 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                  style={{ fontSize: '16px' }}
                />
              </div>
              <div className="flex flex-wrap gap-1 max-h-[120px] overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setIcon('')}
                  className={cn(
                    'w-8 h-8 flex items-center justify-center border transition-colors',
                    icon === ''
                      ? 'border-accent bg-accent/20 text-accent'
                      : 'border-border hover:border-primary hover:bg-muted/30 text-muted-foreground',
                  )}
                >
                  <span className="text-[10px]">--</span>
                </button>
                {filteredIcons.map(entry => {
                  const IconComp = entry.icon
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setIcon(entry.id)}
                      title={entry.id}
                      className={cn(
                        'w-8 h-8 flex items-center justify-center border transition-colors',
                        icon === entry.id
                          ? 'border-accent bg-accent/20 text-accent'
                          : 'border-border hover:border-primary hover:bg-muted/30 text-muted-foreground',
                      )}
                    >
                      <IconComp className="w-4 h-4" />
                    </button>
                  )
                })}
                {filteredIcons.length === 0 && (
                  <span className="text-muted-foreground text-[10px] py-2 px-1">No icons match "{iconSearch}"</span>
                )}
              </div>
              {icon && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Selected: <span className="text-accent">{icon}</span>
                </div>
              )}
            </div>

            {/* Color picker */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Color</div>
              <div className="flex flex-wrap gap-1">
                {COLOR_OPTIONS.map(c => (
                  <button
                    key={c || '__none__'}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      'w-8 h-8 border transition-colors',
                      color === c ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-primary',
                    )}
                    style={c ? { backgroundColor: c } : undefined}
                  >
                    {!c && (
                      <span className="text-muted-foreground text-[10px] flex items-center justify-center h-full">
                        --
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <GroupHeader label="Voice" />

            {/* Keyterms */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Keyterms</span>
                <button
                  type="button"
                  onClick={handleGenerateKeyterms}
                  disabled={generating}
                  className="text-[10px] text-accent hover:text-accent/80 disabled:text-muted-foreground transition-colors"
                >
                  {generating ? 'Generating...' : 'Auto-generate'}
                </button>
              </div>
              {generateError && <div className="text-[10px] text-red-400 mb-1">{generateError}</div>}
              <div className="flex flex-wrap gap-1 mb-1.5">
                {keyterms.map(term => (
                  <span
                    key={term}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-accent/10 border border-accent/30 text-accent text-[10px] font-mono"
                  >
                    {term}
                    <button type="button" onClick={() => removeKeyterm(term)} className="hover:text-red-400 ml-0.5">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
                {keyterms.length === 0 && (
                  <span className="text-muted-foreground text-[10px]">
                    No keyterms -- voice transcription uses defaults
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={keytermInput}
                  onChange={e => setKeytermInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addKeyterm()
                    }
                  }}
                  placeholder="Add term..."
                  className="flex-1 bg-background border border-border px-2 py-1 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                  style={{ fontSize: '16px' }}
                />
                <button
                  type="button"
                  onClick={addKeyterm}
                  disabled={!keytermInput.trim()}
                  className="px-2 py-1 text-[10px] font-bold border border-border text-muted-foreground hover:text-accent hover:border-accent disabled:opacity-30 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          </>
        )}

        {/* ── Launch tab ───────────────────────────────────────────── */}
        {activeTab === 'launch' && (
          <>
            <GroupHeader label="Session Defaults" />

            <SettingRow label="Launch mode" description="Used when spawning/reviving sessions for this project">
              <div className="flex gap-1">
                {[
                  { value: 'headless', label: 'Headless' },
                  { value: 'pty', label: 'PTY' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setLaunchMode(opt.value)}
                    className={cn(
                      'px-2 py-1 text-[10px] font-mono border rounded transition-colors',
                      launchMode === opt.value
                        ? opt.value === 'headless'
                          ? 'border-cyan-500 bg-cyan-500/20 text-cyan-400'
                          : 'border-purple-500 bg-purple-500/20 text-purple-400'
                        : 'border-border/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label="Effort" description="Passed as --effort flag when launching sessions">
              <div className="flex gap-1 flex-wrap">
                {[
                  { value: 'default', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Med' },
                  { value: 'high', label: 'High' },
                  { value: 'xhigh', label: 'XH' },
                  { value: 'max', label: 'Max' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEffort(opt.value)}
                    className={cn(
                      'px-1.5 py-0.5 text-[10px] font-mono border rounded transition-colors',
                      effort === opt.value
                        ? opt.value === 'default'
                          ? 'border-border bg-muted text-foreground'
                          : opt.value === 'low'
                            ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                            : opt.value === 'medium'
                              ? 'border-green-500 bg-green-500/20 text-green-400'
                              : opt.value === 'high'
                                ? 'border-orange-500 bg-orange-500/20 text-orange-400'
                                : 'border-red-500 bg-red-500/20 text-red-400'
                        : 'border-border/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label="Model" description="Passed as --model flag when launching sessions">
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="e.g. sonnet, opus"
                className="w-36 bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </SettingRow>
          </>
        )}

        {/* ── Security tab ─────────────────────────────────────────── */}
        {activeTab === 'security' && (
          <>
            <GroupHeader label="Trust" />

            <SettingRow label="Trust level" description="Controls inter-session messaging approval">
              <div className="flex gap-1">
                {[
                  { value: 'default', label: 'Default' },
                  { value: 'open', label: 'Open' },
                  { value: 'benevolent', label: 'Benevolent' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTrustLevel(opt.value)}
                    className={cn(
                      'px-2 py-1 text-[10px] font-mono border rounded transition-colors',
                      trustLevel === opt.value
                        ? opt.value === 'open'
                          ? 'border-green-500 bg-green-500/20 text-green-400'
                          : opt.value === 'benevolent'
                            ? 'border-amber-500 bg-amber-500/20 text-amber-400'
                            : 'border-border bg-muted text-foreground'
                        : 'border-border/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            <GroupHeader label="Permission Rules" />
            <div className="text-[9px] text-muted-foreground mb-2">
              Auto-approve permission requests. Use Allow All for full trust, or fine-tune per tool. Stored in
              .rclaude/rclaude.json.
            </div>
            <PermissionRulesEditor project={project} />
          </>
        )}
      </div>
    </SettingsShell>
  )
}

// Small edit button to open settings editor
export function ProjectSettingsButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-accent transition-colors p-0.5"
      title="Edit project settings"
    >
      <Pencil className="w-3 h-3" />
    </button>
  )
}
