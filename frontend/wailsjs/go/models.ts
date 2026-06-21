export namespace domain {
	
	export class ImageDesc {
	    filename: string;
	    alt: string;
	    summary: string;
	    detect?: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageDesc(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.alt = source["alt"];
	        this.summary = source["summary"];
	        this.detect = source["detect"];
	    }
	}

}

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

}

