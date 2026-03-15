import {
  Activity,
  AlertTriangle,
  Anchor,
  Archive,
  Award,
  BarChart3,
  Bell,
  Bike,
  Bird,
  Bone,
  Bookmark,
  Bot,
  Box,
  Brain,
  Briefcase,
  Bug,
  Calendar,
  Camera,
  Cat,
  Check,
  Church,
  CircleUser,
  Citrus,
  Clipboard,
  Clock,
  Cloud,
  Code,
  Coffee,
  Cog,
  Compass,
  Construction,
  Cookie,
  Cpu,
  Crown,
  Database,
  Dice1,
  Dog,
  DollarSign,
  Download,
  Drama,
  Dumbbell,
  Ear,
  Eye,
  Factory,
  Feather,
  FileText,
  Fingerprint,
  Fish,
  Flag,
  Flame,
  Folder,
  Footprints,
  Gamepad2,
  Gem,
  Gift,
  GitBranch,
  Glasses,
  Globe,
  GraduationCap,
  Hammer,
  Hand,
  HandMetal,
  Handshake,
  HardDrive,
  Headphones,
  Heart,
  HeartPulse,
  Home,
  Hospital,
  Image,
  Infinity,
  Key,
  Laugh,
  Layers,
  Leaf,
  Library,
  Lightbulb,
  Link,
  Lock,
  type LucideIcon,
  Mail,
  Map,
  MessageCircle,
  Monitor,
  Moon,
  Mountain,
  Music,
  Navigation,
  Package,
  Palette,
  PawPrint,
  Pencil,
  PenTool,
  PersonStanding,
  Phone,
  Pill,
  Pizza,
  Plane,
  Plug,
  Printer,
  Radio,
  Rainbow,
  Rocket,
  Sailboat,
  School,
  Scissors,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  Shield,
  ShoppingCart,
  Skull,
  Smartphone,
  SmilePlus,
  Sparkles,
  Speaker,
  Squirrel,
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
  TrainFront,
  Trash2,
  TreePine,
  Truck,
  Turtle,
  Umbrella,
  University,
  Upload,
  User,
  UserCircle,
  UserRound,
  Users,
  UsersRound,
  UtensilsCrossed,
  Video,
  Volume2,
  Watch,
  Wifi,
  Wind,
  Wine,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  deleteProjectSettings,
  generateProjectKeyterms,
  updateProjectSettings,
  useSessionsStore,
} from '@/hooks/use-sessions'
import type { ProjectSettings } from '@/lib/types'
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
  { id: 'map', icon: Map, keywords: 'map location geography place route' },
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
  { id: 'infinity', icon: Infinity, keywords: 'infinity loop endless forever eternal' },
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
  cwd: string
  onClose: () => void
}

export function ProjectSettingsEditor({ cwd, onClose }: ProjectSettingsEditorProps) {
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const setProjectSettings = useSessionsStore(s => s.setProjectSettings)
  const current = projectSettings[cwd] || {}

  const [label, setLabel] = useState(current.label || '')
  const [icon, setIcon] = useState(current.icon || '')
  const [color, setColor] = useState(current.color || '')
  const [keyterms, setKeyterms] = useState<string[]>(current.keyterms || [])
  const [keytermInput, setKeytermInput] = useState('')
  const [iconSearch, setIconSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  useEffect(() => {
    const c = projectSettings[cwd] || {}
    setLabel(c.label || '')
    setIcon(c.icon || '')
    setColor(c.color || '')
    setKeyterms(c.keyterms || [])
  }, [projectSettings, cwd])

  const filteredIcons = useMemo(() => {
    if (!iconSearch.trim()) return ICONS
    const q = iconSearch.toLowerCase().trim()
    return ICONS.filter(e => e.id.includes(q) || e.keywords.includes(q))
  }, [iconSearch])

  async function handleSave() {
    setSaving(true)
    const settings: ProjectSettings = {}
    if (label.trim()) settings.label = label.trim()
    if (icon) settings.icon = icon
    if (color) settings.color = color
    if (keyterms.length) settings.keyterms = keyterms

    const result = await updateProjectSettings(cwd, settings)
    if (result) setProjectSettings(result)
    setSaving(false)
    onClose()
  }

  async function handleGenerateKeyterms() {
    setGenerating(true)
    setGenerateError(null)
    try {
      const result = await generateProjectKeyterms(cwd)
      if (result) {
        setKeyterms(result.keyterms)
        setProjectSettings(result.settings)
      }
    } catch (err: any) {
      setGenerateError(err.message || 'Failed to generate')
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

  async function handleClear() {
    setSaving(true)
    const result = await deleteProjectSettings(cwd)
    if (result) setProjectSettings(result)
    setSaving(false)
    onClose()
  }

  const hasChanges =
    label.trim() !== (current.label || '') ||
    icon !== (current.icon || '') ||
    color !== (current.color || '') ||
    JSON.stringify(keyterms) !== JSON.stringify(current.keyterms || [])

  const hasAnySettings = current.label || current.icon || current.color || (current.keyterms?.length ?? 0) > 0

  return (
    <Dialog
      open
      onOpenChange={v => {
        if (!v) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <div className="p-4 space-y-3 text-xs">
          {/* Header */}
          <DialogTitle className="text-accent font-bold uppercase tracking-wider text-[10px]">
            Project Settings
          </DialogTitle>

          {/* Label */}
          <div>
            <label className="text-muted-foreground text-[10px] uppercase tracking-wider block mb-1">Label</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={cwd.split('/').pop() || 'project name'}
              className="w-full bg-background border border-border px-2 py-1.5 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
              style={{ fontSize: '16px' }}
            />
          </div>

          {/* Icon picker with search */}
          <div>
            <label className="text-muted-foreground text-[10px] uppercase tracking-wider block mb-1">Icon</label>
            <div className="relative mb-1.5">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={iconSearch}
                onChange={e => setIconSearch(e.target.value)}
                placeholder="Search icons... (rocket, cloud, database...)"
                className="w-full bg-background border border-border pl-6 pr-2 py-1 text-foreground text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted-foreground/50"
                style={{ fontSize: '16px' }}
              />
            </div>
            <div className="flex flex-wrap gap-1 max-h-[120px] overflow-y-auto">
              {/* None/clear option */}
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
                const Icon = entry.icon
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
                    <Icon className="w-4 h-4" />
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
            <label className="text-muted-foreground text-[10px] uppercase tracking-wider block mb-1">Color</label>
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

          {/* Voice Keyterms */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-muted-foreground text-[10px] uppercase tracking-wider">Voice Keyterms</label>
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
                  No keyterms - voice transcription uses defaults
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

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
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
        </div>
      </DialogContent>
    </Dialog>
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
