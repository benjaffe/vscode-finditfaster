// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { workspace } from 'vscode';

import * as cp from 'child_process';
import { cwd, uptime } from 'process';
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
import * as fs from 'fs';
import assert = require('assert');

let term: vscode.Terminal;
// const command = 'fzf --preview "bat --force-colorization --plain {}" | xargs -I{} open "vscode://file/$(pwd)/{}"; clear';

const scriptContents = fs.readFileSync('/Users/tomrijndorp/.dotfiles/system/bin/vscrg.sh', {encoding: 'utf-8'});
console.log('script contents: ', scriptContents);

/**
 * TODO:
 * [x] Auto hide terminal when done
 * [ ] Handle spaces in filenames
 * [ ] Linux support
 * [ ] Windows support
 * [ ] Preferences / options
 * [ ] SSH sessions?
 */

/**
 * Couple of observations:
 * 
 * 1. On Mac OS, opening using open with a URI is _way_ faster than using the `code` command.
 * 2. Depending on the file extension, XCode (?!) will complain that no application is registered,
 *    _even though_ the URI starts with vscode://.
 *    Therefore, we'll pass in the application path. Unfortunately, we can't use the `code` command
 *    for this either, and we'll have to know where VS Code is installed.
 */
function getCFG<T>(key: string, def?: T) {
    // const userCfg = vscode.workspace.getConfiguration(CFG.extensionName);
    const userCfg = vscode.workspace.getConfiguration();
    // console.log('user cfg', userCfg);
    const ret = userCfg.get<T>(`${CFG.extensionName}.${key}`);
    assert(ret !== undefined);
    return ret;
}

const CFG: {
    extensionName: string,
    folders: string[],
    vsCodePath: string,
    showPreview: boolean,
    previewCommand: string,
    workspaceSettings: {
        folders: string[],
    },
    canaryFile: string | null,
    hideTerminalAfterUse: boolean,
    maximizeTerminal: boolean,
    lastActiveTerminal: vscode.Terminal | undefined,
} = {
    extensionName: 'vscode-ripgrep',
    folders: [],
    vsCodePath: '',
    showPreview: true,
    previewCommand: '',
    workspaceSettings: {
        folders: [],
    },
    canaryFile: '/tmp/canaryFile',
    hideTerminalAfterUse: false,
    maximizeTerminal: false,
    lastActiveTerminal: undefined,
};

let count = 0;

function updateConfigWithUserSettings() {
    CFG.vsCodePath = getCFG('general.VS Code Path');
    CFG.showPreview = getCFG('general.showPreview');
    CFG.previewCommand = getCFG('general.previewCommand');
    CFG.hideTerminalAfterUse = getCFG('general.hideTerminalAfterUse');
    CFG.maximizeTerminal = getCFG('general.maximizeTerminal');

    assert(CFG.previewCommand !== '');
}

const getCommand = () => {
    const paths = CFG.folders.join(' ');
    // const cmd = `
    // set -uo pipefail
    // VAL=$( \
    // rg \
    //     --files \
    //     --hidden ${paths} 2>/dev/null \
    // | fzf \
    //     --multi \
    //     --preview "${CFG.previewCommand}" )
    
    // echo "$VAL" > /tmp/lastOutput
    // echo "Got back:"
    // set -x
    // echo "$VAL"

    // if [[ -n "$VAL" ]]; then
    //     echo $VAL | xargs -I{} echo '\-a "${CFG.vsCodePath}" "vscode://file/{}"' && \
    //     echo "${count}" > ${CFG.canaryFile}
    //     echo success
    // else
    //     echo "no success"
    // fi
    // `;
    count++;
    // const cmd2 = `bash -c '${cmd}'`;
    // const cmd2 = 'vscrg.sh';
    const cmd2 = 'bash -c "$THE_SCRIPT"';
    console.log(cmd2);
    return cmd2;
};

function handleWorkspaceFoldersChanges() {
    const updateFolders = () => {
        const dirs = vscode.workspace.workspaceFolders;
        if (dirs === undefined) {
            CFG.folders = ['.'];   // best we can do
        } else {
            CFG.folders = dirs.map(x => {
                const uri = x.uri.toString();
                if (uri.substr(0, 7) === 'file://') {
                    return uri.substr(7);
                } else {
                    vscode.window.showErrorMessage('Non-file:// uri\'s not currently supported...');
                    return '';
                }
            });
            console.log('workspace folders:', CFG.folders);
        }
    };

    updateFolders();

    // Also re-update when anything changes
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
        console.log('workspace folders changed: ', event);
        updateFolders();
    });
}

function handleWorkspaceSettingsChanges() {
    vscode.workspace.onDidChangeConfiguration(e => {
        updateConfigWithUserSettings();
    });
}


export function activate(context: vscode.ExtensionContext) {
    // Because we can't determine what was going on in the terminal panel before,
    // let's just make it a setting for now.
    // CFG.terminalWasVisibleBeforeCommand = false;  // so now we'll always close it
    handleWorkspaceFoldersChanges();
    handleWorkspaceSettingsChanges();
    reinitialize();
    vscode.commands.registerCommand('vscode-ripgrep.shellThing', () => {
        showNext();
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
}

function reinitialize() {

    updateConfigWithUserSettings();
    console.log('plugin config:' ,CFG);
    // CFG.folders = vscode.workspace.getConfiguration().get<any[]>('folders')?.map(x => x.path) || [];
    // console.log(`workspace folders: ${CFG.folders}`);
    // const x = vscode.workspace.getConfiguration().get('folders');
    // console.log('folders:', x);
    // TODO figure this out
    //
    // Set up a file watcher. Any time there is output to our "canary file", we hide the terminal (because the command was completed)
    //
    let watcher;
    const cmd = CFG.canaryFile ? 'true' : 'mktemp';
    cp.exec(cmd, (err, stdout, stderr) => {
        if (err) {
            vscode.window.showErrorMessage(`Failed to initialize plugin (failed to create file watcher: "${stdout}${stderr}")`);
        } else {
            if (!CFG.canaryFile) {
                CFG.canaryFile = stdout.trim();
            }
            console.log('canary file:', CFG.canaryFile);
            watcher = fs.watch(CFG.canaryFile, (eventType, fileName) => {
                if (eventType === 'change') {
                    // Switch back to the terminal the user was on before running our code
                    // if (CFG.lastActiveTerminal !== term && CFG.lastActiveTerminal !== undefined) {
                    //     console.log('A different terminal was active before. Focusing back on that one.', term);
                    //     // CFG.lastActiveTerminal.show();
                    // }
                    if (CFG.hideTerminalAfterUse) {
                        term.hide();
                    }
                }
            });

            //
            // Prepare the terminal for first use. We already enter the command so the user doesn't have to wait.
            //
            prepareTerminal();

        }
    });

}

function prepareTerminal() {
    // TODO lazy instantiation in case terminal is closed (first use / user closed terminal)
    term = vscode.window.createTerminal({
        name: '⚡️',
        cwd: '/Users/tomrijndorp',  // TODO pref
        hideFromUser: true,
        env: {THE_SCRIPT: scriptContents},
    });
}

function showNext() {
    if (!term || term.exitStatus !== undefined) {
        prepareTerminal();
    }
    const cmd = getCommand();
    term.sendText(cmd);
    // We can't, with vscode's API, I think, determine whether the terminal panel was open or
    // not, or what it was showing before we took over. This is unfortunate, not sure how to
    // fix it.
    // CFG.terminalWasVisibleBeforeCommand = 
    CFG.lastActiveTerminal = vscode.window.activeTerminal;
    if (CFG.maximizeTerminal) {
        vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    }
    term.show();
}
