/**
 * PF2e Custom Anachronism
 *
 * Bakes real changes into item data (not cosmetic/prepared overrides):
 *
 *   1. Analog trait  - written into Pathfinder weapons/armor/shields' stored traits.
 *   2. Currency       - coin items renamed + re-iconed (Jiao / Silver Yi / Penny); denomination
 *                      labels come from lang/en.json and the currency-bar icons from styles/coinage.css.
 *   3. Gear renames   - select Starfinder weapons/ammo renamed (Star Gun / Star Rifle / Star Core).
 *
 * Changes are applied two ways:
 *   - on creation, via `preCreateItem` (items dragged onto actors, imported, or made in the world);
 *   - to items that already exist, via a one-time migration over world + actor-owned items.
 *
 * When an item is renamed its `system.slug` is pinned to the ORIGINAL slug, so it keeps its
 * identity for automation, stacking, and @UUID/by-slug references - it is the same item, renamed.
 *
 * The Compendium Browser still reads the original (unbaked) system packs, so a libWrapper on its
 * pack-index loader surfaces the analog trait + renames there for display/filtering.
 */

const MODULE_ID = "pf2e-custom-anachronism";

/** Bump when `computeItemChanges` logic changes so the migration re-runs. */
const MIGRATION_VERSION = 2;

/* -------------------------------------------- */
/*  Configuration                               */
/* -------------------------------------------- */

const ANALOG_TYPES = ["weapon", "armor", "shield"];

/** Presence of any of these means the item is already tech-classified - skip analog. */
const TECH_TRAITS = ["analog", "tech", "powered"];

const WEAPON_RENAMES = [
    { slug: "laser-pistol", id: "qIgcUV22LaDCzmb2", from: "Laser Pistol", to: "Star Gun" },
    { slug: "laser-rifle", id: "0TSUahGsoVnDZ6kv", from: "Laser Rifle", to: "Star Rifle" },
];

const AMMO_RENAMES = [
    { slug: "battery-advanced", id: "eMNjuin4r6DivIsI", from: "Battery (Advanced)", to: "Star Core (Advanced)" },
    { slug: "battery-commercial", id: "0jSc8zqUPnAByMf9", from: "Battery (Commercial)", to: "Star Core (Commercial)" },
    { slug: "battery-elite", id: "6Ac3Vkyp7V0xxRnr", from: "Battery (Elite)", to: "Star Core (Elite)" },
    { slug: "battery-superior", id: "fWrcguxFWeIVsuvl", from: "Battery (Superior)", to: "Star Core (Superior)" },
    { slug: "battery-tactical", id: "5PS5ESGpnQfJNOdg", from: "Battery (Tactical)", to: "Star Core (Tactical)" },
];

/** Coin re-skins, keyed by the original (English) item name. */
const COIN_RESKINS = {
    "Platinum Pieces": { slug: "platinum-pieces", name: "Ten Jiao", img: "icons/sundries/documents/document-bound-white-tan.webp" },
    "Gold Pieces": { slug: "gold-pieces", name: "Jiao", img: "icons/sundries/documents/document-bound-white-tan.webp" },
    "Silver Pieces": { slug: "silver-pieces", name: "Silver Yi", img: "icons/commodities/currency/coin-engraved-oval-steel.webp" },
    "Copper Pieces": { slug: "copper-pieces", name: "Penny", img: "icons/commodities/currency/coin-engraved-square-gold.webp" },
};

// Lookup by original name. Instances get new random _ids on creation, and the Compendium
// Browser exposes the original name on its processed entries, so name is the common key.
const ALL_RENAMES = [...WEAPON_RENAMES, ...AMMO_RENAMES];
const RENAME_BY_NAME = Object.fromEntries(ALL_RENAMES.map((r) => [r.from, r]));

/* -------------------------------------------- */
/*  Shared logic                                */
/* -------------------------------------------- */

/** Works on an item `_source`, a live item, or a raw compendium index entry. */
function qualifiesForAnalog(data) {
    const traits = data?.system?.traits?.value ?? [];
    if (TECH_TRAITS.some((t) => traits.includes(t))) return false;
    return /^pathfinder/i.test(data?.system?.publication?.title ?? "");
}

/**
 * Compute the stored-data changes for one item, or null if none apply.
 * `source` is an item's `_source`; `type` is the item type.
 */
function computeItemChanges(source, type) {
    const updates = {};

    // 1. Analog - add to qualifying Pathfinder gear.
    if (ANALOG_TYPES.includes(type)) {
        const traits = source.system?.traits?.value ?? [];
        if (qualifiesForAnalog(source) && !traits.includes("analog")) {
            updates["system.traits.value"] = [...traits, "analog"];
        }
    }

    // 3. Weapon/ammo renames (pin original slug to preserve identity).
    if (type === "weapon" || type === "ammo") {
        const rename = RENAME_BY_NAME[source.name];
        if (rename && source.name !== rename.to) {
            updates["name"] = rename.to;
            updates["system.slug"] = source.system?.slug ?? rename.slug;
        }
    }

    // 2. Coin re-skin (rename + icon; pin original slug; denomination is price-based, so unaffected).
    if (type === "treasure" && source.system?.category === "coin") {
        const reskin = COIN_RESKINS[source.name];
        if (reskin) {
            if (source.name !== reskin.name) updates["name"] = reskin.name;
            if (source.img !== reskin.img) updates["img"] = reskin.img;
            updates["system.slug"] = source.system?.slug ?? reskin.slug;
        }
    }

    return Object.keys(updates).length > 0 ? updates : null;
}

/* -------------------------------------------- */
/*  Bake on creation                            */
/* -------------------------------------------- */

function registerCreateBake() {
    Hooks.on("preCreateItem", (item) => {
        const updates = computeItemChanges(item._source, item.type);
        if (updates) item.updateSource(updates);
    });
}

/* -------------------------------------------- */
/*  One-time migration of existing items        */
/* -------------------------------------------- */

/** Apply changes to items already present in the world and on actors. Returns counts. */
async function runMigration() {
    const result = { world: 0, owned: 0 };

    const worldUpdates = [];
    for (const item of game.items) {
        const updates = computeItemChanges(item._source, item.type);
        if (updates) worldUpdates.push({ _id: item.id, ...updates });
    }
    if (worldUpdates.length) {
        await Item.updateDocuments(worldUpdates);
        result.world = worldUpdates.length;
    }

    for (const actor of game.actors) {
        const updates = [];
        for (const item of actor.items) {
            const change = computeItemChanges(item._source, item.type);
            if (change) updates.push({ _id: item.id, ...change });
        }
        if (updates.length) {
            await actor.updateEmbeddedDocuments("Item", updates);
            result.owned += updates.length;
        }
    }

    return result;
}

function registerMigration() {
    game.settings.register(MODULE_ID, "migrationVersion", {
        scope: "world",
        config: false,
        type: Number,
        default: 0,
    });

    Hooks.once("ready", async () => {
        // Only the GM responsible for one-time tasks runs this, and only once per version.
        if (game.user !== game.users.activeGM) return;
        if (game.settings.get(MODULE_ID, "migrationVersion") >= MIGRATION_VERSION) return;

        const result = await runMigration();
        await game.settings.set(MODULE_ID, "migrationVersion", MIGRATION_VERSION);
        console.log(`${MODULE_ID} | migration v${MIGRATION_VERSION} complete`, result);
        if (result.world || result.owned) {
            ui.notifications?.info(
                `PF2e Custom Anachronism: updated ${result.world} world item(s) and ${result.owned} owned item(s).`,
            );
        }
    });
}

/* -------------------------------------------- */
/*  Compendium Browser display (libWrapper)     */
/* -------------------------------------------- */

/**
 * Decide from a processed equipment entry's `options` Set whether it should show analog.
 * Mirrors `qualifiesForAnalog`, but reads the browser's option tokens: `type:*`, `trait:*`,
 * and `source:<sluggified-publication>` (Pathfinder gear -> `source:pathfinder-...`).
 */
function indexEntryQualifiesForAnalog(options) {
    if (!(options.has("type:weapon") || options.has("type:armor") || options.has("type:shield"))) return false;
    if (options.has("trait:analog") || options.has("trait:tech") || options.has("trait:powered")) return false;
    for (const opt of options) {
        if (opt.startsWith("source:pathfinder")) return true;
    }
    return false;
}

/**
 * Post-process the equipment tab's results. We wrap the regular `loadData` method rather than the
 * `packLoader.loadPacks` async generator (libWrapper does not reliably wrap generator functions).
 */
function registerEquipmentBrowserWrap() {
    const tab = game.pf2e?.compendiumBrowser?.tabs?.equipment;
    if (!tab) {
        console.warn(`${MODULE_ID} | compendiumBrowser equipment tab not found; browser display not patched`);
        return;
    }
    libWrapper.register(
        MODULE_ID,
        "game.pf2e.compendiumBrowser.tabs.equipment.loadData",
        async function (wrapped, ...args) {
            await wrapped(...args);
            try {
                for (const entry of this.indexData) {
                    // Workaround for a pf2e bug: the price sort reads `priceInCopper`, which the
                    // equipment tab never assigns, so price sorting silently falls back to A-Z.
                    if (entry.priceInCopper === undefined && entry.price) {
                        entry.priceInCopper = entry.price.copperValue ?? 0;
                    }
                    // Display rename (the real item is renamed when added; this keeps the catalog in sync).
                    const renamed = RENAME_BY_NAME[entry.name]?.to;
                    if (renamed) entry.name = renamed;
                    // Display analog so the trait filter matches (real items carry the baked trait).
                    if (entry.options && indexEntryQualifiesForAnalog(entry.options)) {
                        entry.options.add("trait:analog");
                    }
                }
            } catch (error) {
                console.error(`${MODULE_ID} | failed post-processing equipment browser data`, error);
            }
        },
        "WRAPPER",
    );
}

/**
 * Show analog on un-embedded compendium items so a raw compendium sheet matches the browser.
 * The system packs themselves can't be baked (locked + overwritten on update); this is the
 * only display surface left. Never runs on actor/world instances (those carry real baked data).
 */
function registerCompendiumPreview() {
    const previewAnalog = function () {
        if (!this.pack || this.parent) return;
        if (!qualifiesForAnalog(this)) return;
        const traits = this.system?.traits?.value;
        if (Array.isArray(traits) && !traits.includes("analog")) traits.push("analog");
    };
    for (const type of ANALOG_TYPES) {
        libWrapper.register(
            MODULE_ID,
            `CONFIG.PF2E.Item.documentClasses.${type}.prototype.prepareBaseData`,
            function (wrapped, ...args) {
                const out = wrapped(...args);
                try {
                    previewAnalog.call(this);
                } catch (error) {
                    console.error(`${MODULE_ID} | compendium-preview analog failed for ${type}`, error);
                }
                return out;
            },
            "WRAPPER",
        );
    }
}

/* -------------------------------------------- */
/*  Bootstrap                                    */
/* -------------------------------------------- */

Hooks.once("setup", () => {
    // Real-data baking needs no libWrapper, so register it unconditionally.
    registerCreateBake();
    registerMigration();

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { migrate: runMigration, computeItemChanges };

    // Display-only patches need libWrapper.
    if (!globalThis.libWrapper) {
        ui.notifications?.warn(
            `${MODULE_ID}: libWrapper is not active - Compendium Browser display tweaks are disabled (item data is still changed).`,
            { permanent: true },
        );
    } else {
        // Class-prototype wrap is available now.
        registerCompendiumPreview();
        // The Compendium Browser is built in pf2e's own "ready" hook, so wrap it on ready
        // (our ready listener is registered after pf2e's, so the browser already exists).
        Hooks.once("ready", () => registerEquipmentBrowserWrap());
    }

    console.log(`${MODULE_ID} | setup complete`);
});
