import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { IControllerDataBase } from "./data";
import { IPlatformData } from "./platform";
import { IProjectData } from "./project";

declare global {
	interface IPrepareData extends IControllerDataBase {
		release: boolean;
		hmr: boolean;
		env: any;
		watch?: boolean;
		watchNative: boolean;
		watchNodeModules?: boolean;

		// embedding
		hostProjectPath?: string;
	}

	interface IiOSCodeSigningData {
		teamId: string;
		provision: string;
		mobileProvisionData: any;
	}

	interface IiOSPrepareData extends IPrepareData, IiOSCodeSigningData {}

	interface IPrepareDataService {
		getPrepareData(
			projectDir: string,
			platform: string,
			data: any
		): IPrepareData;
	}

	interface IPrepareController extends EventEmitter {
		prepare(prepareData: IPrepareData): Promise<IPrepareResultData>;
		stopWatchers(projectDir: string, platform: string): Promise<void>;
		toggleFileWatcher: () => Promise<boolean>;
		// toggleWatchNodeModules: () => Promise<boolean>;
	}

	interface IPrepareResultData {
		platform: string;
		hasNativeChanges: boolean;
	}

	interface IPrepareNativePlatformService {
		prepareNativePlatform(
			platformData: IPlatformData,
			projectData: IProjectData,
			prepareData: IPrepareData
		): Promise<boolean>;
	}

	var prepare: Promise<IPrepareResultData>;  // Doesn't work with `const`???
	var webpackCp: ChildProcess;  // Doesn't work with `const`???
	/** Whether there is currently a build in progress so we know to ignore chokidar changes
	 * detected in native directories */
	var buildInProgress: boolean;
	
	var ruleAdded: boolean
	var lastSeenPort: number
	var frontendWaitingPort: boolean
}
