import * as constants from "../../constants";
import { injector } from "../../common/yok";
import {
	ISpawnResult,
	IErrors,
	IChildProcess,
} from "../../common/declarations";

export class XcodebuildCommandService implements IXcodebuildCommandService {
	constructor(
		private $childProcess: IChildProcess,
		private $errors: IErrors,
		private $logger: ILogger
	) {}

	public async executeCommand(
		args: string[],
		options: {
			cwd: string;
			stdio: string;
			message?: string;
			spawnOptions?: any;
		}
	): Promise<ISpawnResult> {
		const { message, cwd, stdio, spawnOptions } = options;
		this.$logger.info(message || "Xcode build...");

		const childProcessOptions = { cwd, stdio: stdio || "inherit" };

		// // Unlock keychain first (required for building from ssh client)
		// try {
		// 	await this.$childProcess.spawnFromEvent(
		// 		"security",
		// 		["unlock-keychain"],
		// 		"exit",
		// 		{ cwd, stdio: 'inherit' },
		// 		{ throwError: false }
		// 	)
		// } catch (error) {
		// 	this.$logger.warn(`Unable to unlock keychain. Error is: ${error.message}`)
		// }

		try {
			const commandResult = await this.$childProcess.spawnFromEvent(
				"xcodebuild",
				args,
				"exit",
				childProcessOptions,
				spawnOptions || {
					emitOptions: { eventName: constants.BUILD_OUTPUT_EVENT_NAME },
					throwError: true,
				}
			);

			return commandResult;
		} catch (err) {
			this.$errors.fail(err.message);
		}
	}
}
injector.register("xcodebuildCommandService", XcodebuildCommandService);
