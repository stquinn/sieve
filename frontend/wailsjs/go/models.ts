export namespace main {
	
	export class AssetDTO {
	    externalRef: string;
	    encoding: string;
	
	    static createFrom(source: any = {}) {
	        return new AssetDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.externalRef = source["externalRef"];
	        this.encoding = source["encoding"];
	    }
	}
	export class VersionRefDTO {
	    id: string;
	    created: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new VersionRefDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.created = source["created"];
	        this.size = source["size"];
	    }
	}
	export class DocumentMetaDTO {
	    status: string;
	    version: number;
	    focusCount: number;
	    userIntent?: string;
	    aiEval: string;
	    aiLastEvaluated?: string;
	    aiFolderSuggestion?: string;
	    userSuggestedName?: string;
	    displayName: string;
	    filename?: string;
	    summary?: string;
	    tags: string[];
	    aiJustification?: string;
	    densitySignals: string[];
	    created: string;
	    modified: string;
	    cli?: string;
	    aiKeep?: boolean;
	    scroll: number;
	    assets: any[];
	    all: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new DocumentMetaDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.version = source["version"];
	        this.focusCount = source["focusCount"];
	        this.userIntent = source["userIntent"];
	        this.aiEval = source["aiEval"];
	        this.aiLastEvaluated = source["aiLastEvaluated"];
	        this.aiFolderSuggestion = source["aiFolderSuggestion"];
	        this.userSuggestedName = source["userSuggestedName"];
	        this.displayName = source["displayName"];
	        this.filename = source["filename"];
	        this.summary = source["summary"];
	        this.tags = source["tags"];
	        this.aiJustification = source["aiJustification"];
	        this.densitySignals = source["densitySignals"];
	        this.created = source["created"];
	        this.modified = source["modified"];
	        this.cli = source["cli"];
	        this.aiKeep = source["aiKeep"];
	        this.scroll = source["scroll"];
	        this.assets = source["assets"];
	        this.all = source["all"];
	    }
	}
	export class BufferDTO {
	    kind: string;
	    uuid: string;
	    path: string;
	    slug: string;
	    body: string;
	    meta: DocumentMetaDTO;
	    versions: VersionRefDTO[];
	
	    static createFrom(source: any = {}) {
	        return new BufferDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.uuid = source["uuid"];
	        this.path = source["path"];
	        this.slug = source["slug"];
	        this.body = source["body"];
	        this.meta = this.convertValues(source["meta"], DocumentMetaDTO);
	        this.versions = this.convertValues(source["versions"], VersionRefDTO);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class EvaluateAndFileResult {
	    discarded: boolean;
	    doc: BufferDTO;
	
	    static createFrom(source: any = {}) {
	        return new EvaluateAndFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.discarded = source["discarded"];
	        this.doc = this.convertValues(source["doc"], BufferDTO);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NoteDTO {
	    kind: string;
	    uuid: string;
	    path: string;
	    slug: string;
	    body: string;
	    meta: DocumentMetaDTO;
	    versions: VersionRefDTO[];
	
	    static createFrom(source: any = {}) {
	        return new NoteDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.uuid = source["uuid"];
	        this.path = source["path"];
	        this.slug = source["slug"];
	        this.body = source["body"];
	        this.meta = this.convertValues(source["meta"], DocumentMetaDTO);
	        this.versions = this.convertValues(source["versions"], VersionRefDTO);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class StoreInfo {
	    root: string;
	    hostname: string;
	    buffersPath: string;
	    notesPath: string;
	    isNew: boolean;
	    tier: number;
	    cli: string;
	    debug: boolean;
	    autosaveDebounce: number;
	    themeName: string;
	    themeVars: Record<string, string>;
	    maxHistoryVersions: number;
	    cliTimeoutLong: number;
	    showPrompts: boolean;
	
	    static createFrom(source: any = {}) {
	        return new StoreInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.hostname = source["hostname"];
	        this.buffersPath = source["buffersPath"];
	        this.notesPath = source["notesPath"];
	        this.isNew = source["isNew"];
	        this.tier = source["tier"];
	        this.cli = source["cli"];
	        this.debug = source["debug"];
	        this.autosaveDebounce = source["autosaveDebounce"];
	        this.themeName = source["themeName"];
	        this.themeVars = source["themeVars"];
	        this.maxHistoryVersions = source["maxHistoryVersions"];
	        this.cliTimeoutLong = source["cliTimeoutLong"];
	        this.showPrompts = source["showPrompts"];
	    }
	}
	
	export class VersionedStorableDTO {
	    ref: VersionRefDTO;
	    body: string;
	    meta: DocumentMetaDTO;
	
	    static createFrom(source: any = {}) {
	        return new VersionedStorableDTO(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ref = this.convertValues(source["ref"], VersionRefDTO);
	        this.body = source["body"];
	        this.meta = this.convertValues(source["meta"], DocumentMetaDTO);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace stash {
	
	export class FilingRecommendation {
	    keep: boolean;
	    title: string;
	    filename: string;
	    folder: string;
	    new_folder: boolean;
	    type: string;
	    summary: string;
	    tags: string[];
	    ai_justification: string;
	    density_signals: string[];
	
	    static createFrom(source: any = {}) {
	        return new FilingRecommendation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.keep = source["keep"];
	        this.title = source["title"];
	        this.filename = source["filename"];
	        this.folder = source["folder"];
	        this.new_folder = source["new_folder"];
	        this.type = source["type"];
	        this.summary = source["summary"];
	        this.tags = source["tags"];
	        this.ai_justification = source["ai_justification"];
	        this.density_signals = source["density_signals"];
	    }
	}
	export class ImageDesc {
	    filename: string;
	    alt: string;
	    summary: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageDesc(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.alt = source["alt"];
	        this.summary = source["summary"];
	    }
	}
	export class NoteEntry {
	    name: string;
	    displayName?: string;
	    status?: string;
	    path?: string;
	    userIntent?: string;
	    isDir: boolean;
	    children?: NoteEntry[];
	
	    static createFrom(source: any = {}) {
	        return new NoteEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.displayName = source["displayName"];
	        this.status = source["status"];
	        this.path = source["path"];
	        this.userIntent = source["userIntent"];
	        this.isDir = source["isDir"];
	        this.children = this.convertValues(source["children"], NoteEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PromptEntry {
	    name: string;
	    displayName: string;
	    path: string;
	    isVirtual: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PromptEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.displayName = source["displayName"];
	        this.path = source["path"];
	        this.isVirtual = source["isVirtual"];
	    }
	}
	export class SearchResult {
	    path: string;
	    name: string;
	    isTagMatch: boolean;
	    isSummaryMatch: boolean;
	    isBodyMatch: boolean;
	    snippet: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.isTagMatch = source["isTagMatch"];
	        this.isSummaryMatch = source["isSummaryMatch"];
	        this.isBodyMatch = source["isBodyMatch"];
	        this.snippet = source["snippet"];
	    }
	}
	export class Window {
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	
	    static createFrom(source: any = {}) {
	        return new Window(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	    }
	}
	export class Tab {
	    id: string;
	    path: string;
	    scroll: number;
	    active: boolean;
	    mode: string;
	    displayName?: string;
	    status?: string;
	    userIntent?: string;
	
	    static createFrom(source: any = {}) {
	        return new Tab(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.scroll = source["scroll"];
	        this.active = source["active"];
	        this.mode = source["mode"];
	        this.displayName = source["displayName"];
	        this.status = source["status"];
	        this.userIntent = source["userIntent"];
	    }
	}
	export class Session {
	    activeIdx: number;
	    tabs: Tab[];
	    window?: Window;
	    sidebarWidth?: number;
	    metaWidth?: number;
	    showSidebar: boolean;
	    showMeta: boolean;
	    showPrompts: boolean;
	    promptsHeight?: number;
	    openFolders?: string[];
	    lastSettingsPanel?: string;
	
	    static createFrom(source: any = {}) {
	        return new Session(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.activeIdx = source["activeIdx"];
	        this.tabs = this.convertValues(source["tabs"], Tab);
	        this.window = this.convertValues(source["window"], Window);
	        this.sidebarWidth = source["sidebarWidth"];
	        this.metaWidth = source["metaWidth"];
	        this.showSidebar = source["showSidebar"];
	        this.showMeta = source["showMeta"];
	        this.showPrompts = source["showPrompts"];
	        this.promptsHeight = source["promptsHeight"];
	        this.openFolders = source["openFolders"];
	        this.lastSettingsPanel = source["lastSettingsPanel"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    cli?: string;
	    model?: string;
	    cli_timeout?: number;
	    cli_timeout_long?: number;
	    autosave_debounce?: number;
	    debug?: boolean;
	    theme?: string;
	    max_history_versions?: number;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cli = source["cli"];
	        this.model = source["model"];
	        this.cli_timeout = source["cli_timeout"];
	        this.cli_timeout_long = source["cli_timeout_long"];
	        this.autosave_debounce = source["autosave_debounce"];
	        this.debug = source["debug"];
	        this.theme = source["theme"];
	        this.max_history_versions = source["max_history_versions"];
	    }
	}
	

}

