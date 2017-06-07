const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const groupBy = require('group-by');
const sizeOf = require('image-size');
const readChunk = require('read-chunk');
const imageType = require('image-type');

const toml = require('toml');

let currentGame = null;
let errors = [];

function getDirectories(srcpath) {
    return fs.readdirSync(srcpath)
        .filter(file => fs.lstatSync(path.join(srcpath, file)).isDirectory())
}

function getFiles(srcpath) {
    return fs.readdirSync(srcpath)
        .filter(file => fs.lstatSync(path.join(srcpath, file)).isFile())
}

/// Validates that a image is correctly sized and of the right format.
function validateImage(path, config) {
    if (fs.existsSync(path) === false) {
        validationError(`Image \"${path}\"' was not found at ${path}.`);
    } else {
        // Read first 12 bytes (enough for '%PNG', etc)
        const buffer = readChunk.sync(path, 0, 12);
        const type = imageType(buffer).mime;
        if (type !== config.type) {
            validationError(`Incorrect format of image (${type} != ${config.type})`);
        }

        let dimensions = sizeOf(path);
        if (dimensions.width !== config.width || dimensions.height !== config.height) {
            validationError(`Image \"${path}\"'s dimensions are ${dimensions.width} x ${dimensions.height} ` +
                            `instead of the required ${config.width} x ${config.height}.`);
        }
    }
}

/// Validates that a folder (if it exists) of images contains images that are
//   correctly sized and of the right format.
function validateDirImages(path, config) {
    // TODO: Do we want to enforce having screenshots?
    if (fs.existsSync(path)) {
        const files = getFiles(path);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            validateImage(`${path}/${file}`, config);
        }
    }
}

// TODO: Could these errors be prefixed with the section/line in which they come from?

/// Validates the existance of a particular entry in a structure
function validateExists(struct, name) {
    if (struct[name] === undefined) {
        validationError("Field \"" + name + "\" missing");
        return false;
    } else {
        return true;
    }
}

/// Validates the existence of a particular entry in a structure, and
/// ensures that it meets a particular set of criteria.
function validateContents(struct, name, test) {
    if (validateExists(struct, name)) {
        test(struct[name]);
    }
}

/// Validates the existence of a particular entry in a structure, and
/// ensures that it is not a empty string.
function validateNotEmpty(struct, name) {
    validateContents(struct, name, field => {
        if (typeof field !== "string") {
            validationError("Field \"" + name + "\" is not a string");
        } else if (field === "") {
            validationError("Field \"" + name + "\" is empty");
        }
    });
}

/// Validates the existence of a particular entry in a structure, and
/// ensures that it is not a empty string.
function validateIsBoolean(struct, name) {
    if (struct[name] !== false && struct[name] !== true) {
        validationError("Field \"" + name + "\" is not a boolean");
    }
}

/// Validates pattern of YYYY-MM-DD in a field of a structure.
function validateIsDate(struct, name) {
    validateContents(struct, name, field => {
        if (!field.match(/[0-9]{4}-((0[1-9])|(1[0-2]))-((0[1-9])|([1-2][0-9])|(3[0-1]))/)) {
            validationError(`\"${name}\" is not a valid date (\"${field}\").`);
        }
    });
}

function validateFileExists(dir) {
    if (fs.existsSync(dir) === false) {
        validationError(`\"${dir}\" does not exist!`);
        return false;
    }
    return true;
}

/// Validates a TOML document
function validateTOML(path) {
    if (fs.existsSync(path) === false) {
        validationError(`TOML was not found at ${path}.`);
        return;
    }

    let rawContents = fs.readFileSync(path);
    let tomlDoc;
    try {
        tomlDoc = toml.parse(rawContents);
    } catch (e) {
        validationError("TOML parse error (" + e.line + "): " + e.message);
        return;
    }

    // Check the global header section
    validateNotEmpty(tomlDoc, "title");
    validateNotEmpty(tomlDoc, "description");
    if (tomlDoc["github_issues"] !== undefined) {
        validateContents(tomlDoc, "github_issues", field => {
            if (Array.isArray(field) === false) {
                validationError("Github issues field is not an array!")
            } else {
                // Validate each individual entry
                for (x in field) {
                    if (typeof field[x] !== "number") {
                        validationError("Github issues entry is not a number!")
                    }
                }
            }
        });
    }

    let section;
    let i;

    // Check each release individually
    if (tomlDoc["releases"] !== undefined) {
        section = tomlDoc["releases"];
        for (i = 0; i < section.length; i++) {
            const release = section[i];

            validateContents(release, "title", field => {
                if (field.length !== 16) {
                    validationError(`Release #${i + 1}: Game title ID has an invalid length`);
                } else if (!field.match(/([a-zA-Z0-9]){16}/)) {
                    validationError(`Release #${i + 1}: Game title ID is not a hexadecimal ID`);
                }
            });
            validateContents(release, "region", field => {
                if (config.regions.indexOf(field) === -1) {
                    validationError(`Release #${i + 1}: Invalid region ${field}`);
                }
            });
            validateIsDate(release, "release_date");

        }
    } else {
        validationError("No releases.")
    }

    let maxCompatibility = 999;

    // Check each testcase individually
    if (tomlDoc["testcases"] !== undefined) {
        section = tomlDoc["testcases"];
        for (i = 0; i < section.length; i++) {
            const testcase = section[i];

            validateNotEmpty(testcase, "compatibility");
            if (testcase["compatibility"] !== undefined) {
                let compat = parseInt(testcase["compatibility"]);
                if (compat < maxCompatibility) {
                    maxCompatibility = compat;
                }
            }

            validateIsDate(testcase, "date");
            validateContents(testcase, "version", test => {
                if (test.length !== 12) {
                    validationError(`Testcase #${i + 1}: Version is of incorrect length`);
                } else if (!test.startsWith("HEAD-")) {
                    validationError(`Testcase #${i + 1}: Unknown version commit source`);
                }
            });
            validateNotEmpty(testcase, "author");

            // TODO: CPU/GPU/OS fields
        }
    } else {
        validationError("No testcases.")
    }

    // We only check these if we have a known test result (we cannot know if a game needs
    //  resources if it doesn't even run!)
    if (maxCompatibility < 5) {
        validateIsBoolean(tomlDoc, "needs_system_files");
        validateIsBoolean(tomlDoc, "needs_shared_font");
    }
}

/// Validates the basic structure of a save game's TOML. Assumes it exists.
function validateSaveTOML(path) {
    let rawContents = fs.readFileSync(path);
    let tomlDoc;
    try {
        tomlDoc = toml.parse(rawContents);
    } catch (e) {
        validationError("TOML parse error (" + e.line + "): " + e.message);
        return;
    }

    // Check the global header section
    validateNotEmpty(tomlDoc, "title");
    validateNotEmpty(tomlDoc, "description");
    validateNotEmpty(tomlDoc, "author");
    validateContents(tomlDoc, "title_id", field => {
        if (field.length !== 16) {
            validationError(`Game save data: Game title ID has an invalid length`);
        } else if (!field.match(/([a-zA-Z0-9]){16}/)) {
            validationError(`Game save data: Game title ID is not a hexadecimal ID`);
        }
    });
}

/// Validates that a save is actually a .zip.
function validateSaveZip(path) {
    // TODO: Would a node library MIME check be better?
    const zipHeader = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

    const data = readChunk.sync(path, 0, 4);

    if (zipHeader.compare(data) !== 0) {
        validationError(`File ${path} is not a .zip!`)
    }
}

/// Validates a folder of game saves.
function validateSaves(dir) {
    if (fs.existsSync(dir) === false) {
        return;
    }

    const files = getFiles(dir);

    // Strip extensions, so we know what save 'groups' we are dealing with
    const strippedFiles = files.map(file => {
        return file.substr(0, file.lastIndexOf("."))
    });

    const groups = strippedFiles.filter((element, i) => {
        return strippedFiles.indexOf(element) === i
    });

    // Check each group
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (validateFileExists(`${dir}/${group}.dat`)) {
            validateSaveTOML(`${dir}/${group}.dat`);
        }
        if (validateFileExists(`${dir}/${group}.zip`)) {
            validateSaveZip(`${dir}/${group}.zip`);
        }
    }
}

function validationError(err) {
    errors.push({game: currentGame, error: err});
}

// Loop through each game folder, validating each game.
getDirectories(config.directory).forEach(function (game) {
    try {
        if (game === '.git' || game === '_validation') {
            return;
        }

        let inputDirectoryGame = `${config.directory}/${game}`;
        currentGame = game;

        // Verify the game's boxart.
        validateImage(`${inputDirectoryGame}/${config.boxart.filename}`, config.boxart);

        // Verify the game's image.
        validateImage(`${inputDirectoryGame}/${config.icon.filename}`, config.icon);

        // Verify the game's metadata.
        validateTOML(`${inputDirectoryGame}/${config.data.filename}`);

        // Verify the game's screenshots.
        validateDirImages(`${inputDirectoryGame}/${config.screenshots.dirname}`,
                            config.screenshots);

        // Verify the game's save files.
        validateSaves(`${inputDirectoryGame}/${config.saves.dirname}`);

    } catch (ex) {
        console.warn(`${game} has encountered an unexpected error.`);
        console.error(ex);
    }
});

if (errors.length > 0) {
    console.warn('Validation completed with errors.');

    const groups = groupBy(errors, "game");

    for (let key in groups) {
        let group = groups[key];

        console.info(`  ${key}:`);

        for (let issueKey in group) {
            console.info(`   - ${group[issueKey].error}`);
        }
    }

    process.exit(1);
} else {
    console.info('Validation completed without errors.');
    process.exit(0);
}
 