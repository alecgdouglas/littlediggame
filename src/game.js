// Copyright (c) 2025 Alexander Douglas
// Licensed under the MIT License.
// See LICENSE file in the project root for full license information.

import PerfStats from "stats.js";
import Audio from "./audio.js";
import Color from "./color.js";
import CooldownButton from "./cooldown_button.js";
import CssEffects from "./css_effects.js";
import Dialogs from "./dialogs.js";
import PixelConstants from "./diggables/constants.js";
import Pixel from "./diggables/pixel.js";
import PixelType from "./diggables/pixel_type.js";
import GameOverArt from "./game_over_art.js";
import GameState from "./game_state.js";
import Hourglass from "./hourglass.js";
import Layer from "./layer.js";
import LittleGuys from "./little_guys.js";
import MathExtras from "./math_extras.js";
import Particles from "./particles.js";
import CircularPlanet from "./pixel_bodies/circular_planet.js";
import EggPlanet from "./pixel_bodies/egg_planet.js";
import Planet from "./pixel_bodies/planet.js";
import Serpent from "./pixel_bodies/serpent.js";
import SpikyPlanet from "./pixel_bodies/spiky_planet.js";
import SwissPlanet from "./pixel_bodies/swiss_planet.js";
import SaveLoad from "./save_load.js";
import Sky from "./sky.js";
import Stats from "./stats.js";
import Story from "./story.js";
import Upgrades from "./upgrades.js";
import UpgradesUi from "./upgrades_ui.js";
import Vector from "./vector.js";

export default class Game {
    MIN_WIDTH = 300;
    MAX_WIDTH = 1200;
    MIN_HEIGHT = 300;
    MAX_HEIGHT = 900;
    WINDOW_SIZE_BUFFER = new Vector(30, 40);
    MIN_SAVE_INTERVAL_MS = 5000;
    AUTO_SAVE_INTERVAL_MS = 30000;
    TARGET_FPS = 60;
    FRAME_INTERVAL_MS = 1000 / this.TARGET_FPS;
    ZOOM_DURATION_MS = 1000 * 2;
    GAME_OVER_ZOOM_DURATION_MS = 1000 * 20;
    FINAL_LEVEL_DURATION_MINUTES = 3;
    MAX_LITTLE_GUYS = 200;
    SHIELD_DURATION_MS = 1000 * 3;
    SHIELD_COST_PER_LITTLE_GUY = 302;

    constructor(pixelBodies, upgrades, littleGuys) {
        this.width = 0;
        this.height = 0;
        this.zoomLevel = 1;
        this.zoomLevelSrc = 1;
        this.zoomLevelDst = 1;
        this.zoomElapsedMs = 0;
        this.bounds = new Vector();
        this.layer = null;
        this.sky = new Sky();
        this.upgrades = upgrades ?? new Upgrades();
        if (pixelBodies == null) {
            this.pixelBodies = [];
            this.pixelBodies.push(new CircularPlanet(7));
            this.pixelBodies.push(new SwissPlanet(13));
            this.pixelBodies.push(new SpikyPlanet(22));
            this.pixelBodies.push(new EggPlanet(35));
            this.pixelBodies.push(new Serpent(140, 84));
        } else {
            this.pixelBodies = pixelBodies;
        }
        this.activePixelBodyPosition = new Vector();

        // Unset or derived from ctor args
        this.now = 0;
        this.then = 0;
        this.upgradesUi = new UpgradesUi();

        this.stats = new Stats();

        // Created during init()
        this.containerElement = null;

        this.littleGuys = littleGuys ?? new LittleGuys();
        this.littleGuys.addListener({
            onDigsComplete: (pixels) => {
                this.handleDigsComplete(pixels);
            },
            onDeath: (littleGuy) => {
                this.handleDeath(littleGuy);
            },
            onInactive: (littleGuy) => {
                this.handleInactive(littleGuy);
            },
        });
        this.spawningAllowed = true;

        this.particles = new Particles();
        this.hourglass = new Hourglass(27, 70, this.FINAL_LEVEL_DURATION_MINUTES * 60);
        this.hourglassPosition = new Vector();

        this.gameOverArt = new GameOverArt();

        this.knowsDeath = false;
        this.knowsEggDeath = false;
        this.knowsDirt = false;
        this.aspis = 0;
        this.aspisNeedsUpdate = true;
        this.aspisElement = null;
        this.upgradesAspisElement = null;
        this.healthElement = null;
        this.spawnCost = 0;
        this.spawnCostElement = null;
        this.digsPerDeathElement = null;
        this.purchasableUpgradeCountEl = 0;
        this.shieldActive = false;
        this.shieldCost = 0;
        this.shieldCostElement = null;
        this.shieldCostContainerElement = null;
        this.shieldCooldownButton = null;

        this.eggRevealCallback = () => {
            const body = this.activePixelBody;
            if (!body) {
                return;
            }
            this.sky.setColors(body.altSkyColors, Sky.DEFAULT_TRANSITION_DURATION_FRAMES * 2);
            Audio.instance.play(Audio.STORY_SKY_CHANGE);
        };

        this.bloodDiamondEffectShown = false;

        this.workerEv = 0;

        this.lastConceptionTime = 0;

        if (window.DEBUG) {
            this.perfStats = new PerfStats();
            this.perfStats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
            this.perfStats.dom.style.left = "90%";
            console.log("Appending stats panel");
            document.body.appendChild(this.perfStats.dom);
        }
        this.gameState = GameState.UNINITIALIZED;
        this.lastSaved = -this.MIN_SAVE_INTERVAL_MS;
        this.autoSaveTimeout = null;
    }

    toJSON() {
        return {
            className: this.constructor.name,
            upgrades: this.upgrades,
            // TODO: For some reason, on every save/load cycle, the layer size gets larger.
            pixelBodies: this.pixelBodies.map((pb) => pb.toJSON()),
            // Do we actually need this?
            activePixelBodyPosition: this.activePixelBodyPosition,
            littleGuys: this.littleGuys,
            spawningAllowed: this.spawningAllowed,
            aspis: this.aspis,
            knowsDeath: this.knowsDeath,
            knowsDirt: this.knowsDirt,
            knowsEggDeath: this.knowsEggDeath,
            bloodDiamondEffectShown: this.bloodDiamondEffectShown,
            story: Story.instance,
            stats: this.stats,
        };
    }

    static fromJSON(json) {
        const upgrades = Upgrades.fromJSON(json.upgrades);
        const pixelBodies = [];
        for (let pixelBodyJson of json.pixelBodies) {
            if (pixelBodyJson.className == CircularPlanet.name) {
                // Covers both plain circular planets and egg planets (who both have the same dirt
                // variant).
                pixelBodies.push(CircularPlanet.fromJSON(pixelBodyJson, upgrades));
            } else if (pixelBodyJson.className == SwissPlanet.name) {
                pixelBodies.push(SwissPlanet.fromJSON(pixelBodyJson, upgrades));
            } else if (pixelBodyJson.className == SpikyPlanet.name) {
                pixelBodies.push(SpikyPlanet.fromJSON(pixelBodyJson, upgrades));
            } else if (pixelBodyJson.className == EggPlanet.name) {
                pixelBodies.push(EggPlanet.fromJSON(pixelBodyJson, upgrades));
            } else if (pixelBodyJson.className == Serpent.name) {
                pixelBodies.push(Serpent.fromJSON(pixelBodyJson, upgrades));
            } else {
                console.error("Unknown pixel body type: " + pixelBodyJson.className);
            }
        }
        const littleGuys = LittleGuys.fromJSON(
            json.littleGuys,
            pixelBodies.length > 0 ? pixelBodies[0] : null,
            upgrades
        );
        const game = new Game(pixelBodies, upgrades, littleGuys);

        game.spawningAllowed = json.spawningAllowed;
        game.aspis = json.aspis;
        game.knowsDeath = json.knowsDeath;
        game.knowsDirt = json.knowsDirt;
        game.knowsEggDeath = json.knowsEggDeath;
        game.bloodDiamondEffectShown = json.bloodDiamondEffectShown;

        Story.fromJSON(json.story);

        game.stats = Stats.fromJSON(json.stats);

        return game;
    }

    init(windowWidth, windowHeight, containerElement) {
        console.log("Initializing game");
        this.containerElement = containerElement;
        this.upgradesUi.init(
            document.getElementById("upgrades"),
            document.getElementById("upgrades-hints"),
            this.upgrades,
            // onPurchase callback
            (upgrade, button) => {
                this.onUpgradePurchased(upgrade, button);
            },
            () => this.aspis
        );
        this.updateActivePixelBodyPosition();
        if (this.activePixelBody) {
            this.activePixelBody.init(this.upgrades);
            this.sky.setColors(this.activePixelBody.skyColors);
        }
        this.sky.init();
        this.onResize(windowWidth, windowHeight, containerElement);
        console.log(
            "Main canvas bounds: " + new Vector(this.layer.width, this.layer.height).toString()
        );

        this.littleGuys.init(this.layer.width / this.zoomLevel, this.layer.height / this.zoomLevel);
        this.particles.init(this.layer.width / this.zoomLevel, this.layer.height / this.zoomLevel);

        this.initUi();

        this.gameState = GameState.PAUSED;
        this.setPaused(false);

        Story.instance.preload();
        setTimeout(() => {
            Story.instance.showIntro();
        }, 1000);
    }

    initUi() {
        const saveGameBtn = document.getElementById("save-game");
        saveGameBtn.addEventListener("click", () => {
            console.log("Saving...");
            if (this.gameState === GameState.RUNNING) {
                this.stats.updateRuntime();
            }
            SaveLoad.save(this);
            console.log("Saved");
        });
        saveGameBtn.removeAttribute("disabled");

        const pauseBtn = document.getElementById("pause-resume");
        pauseBtn.addEventListener("click", () => {
            document.getElementById("pause-icon").classList.toggle("hidden");
            document.getElementById("play-icon").classList.toggle("hidden");
            document.getElementById("pause-scrim").classList.toggle("hidden");
            this.setPaused(!GameState.isPaused(this.gameState));
        });

        if (window.DEBUG) {
            const nextPixelBodyBtn = document.getElementById("next-pixel-body");
            nextPixelBodyBtn.addEventListener("click", () => {
                this.goToNextPixelBody();
            });
            const bloodBtn = document.getElementById("blood");
            bloodBtn.addEventListener("change", () => {
                this.blood = bloodBtn.checked;
                console.log("Blood: " + bloodBtn.checked);
            });

            for (let i = 0; i < 4; i++) {
                const pow = i + 1;
                const val = 10 ** pow;
                const plusBtn = document.getElementById("plus-" + val);
                plusBtn.addEventListener("click", () => {
                    this.aspis += val;
                    this.aspisNeedsUpdate = true;
                });
            }
        }

        const upgradesContainer = document.getElementById("upgrades-container");
        const showUpgradesBtn = document.getElementById("show-upgrades");
        showUpgradesBtn.addEventListener("click", () => {
            console.log("Showing upgrades screen w/ Health: " + this.activePixelBody?.health);
            upgradesContainer.classList.remove("hidden");
            showUpgradesBtn.classList.add("hidden");
            Audio.instance.play(Audio.UI_UPGRADES_OPEN);
            this.upgradesUi.onShown(this.aspis);
            Dialogs.pause();
        });
        const hideUpgradesBtn = document.getElementById("hide-upgrades");
        hideUpgradesBtn.addEventListener("click", () => {
            upgradesContainer.classList.add("hidden");
            showUpgradesBtn.classList.remove("hidden");
            Audio.instance.play(Audio.UI_UPGRADES_CLOSE);
            this.upgradesUi.onHidden();
            if (!GameState.isPaused(this.gameState)) {
                Dialogs.resume();
            }
            this.maybeBloodDiamondEffect();
        });
        this.purchasableUpgradeCountEl = document.getElementById("purchasable-upgrade-count");

        this.aspisElement = document.getElementById("aspis");
        this.upgradesAspisElement = document.getElementById("upgrades-aspis");
        this.aspisNeedsUpdate = true;

        this.healthElement = document.getElementById("health");
        this.updateHealth();

        this.shieldCostElement = document.getElementById("shield-cost");
        this.shieldCostContainerElement = this.shieldCostElement.parentElement;
        const shieldButtonEl = document.getElementById("shield");
        shieldButtonEl.addEventListener("click", () => {
            if (GameState.isPaused(this.gameState)) {
                return;
            }
            this.activateShield();
        });
        this.shieldCooldownButton = new CooldownButton(
            shieldButtonEl,
            this.SHIELD_DURATION_MS,
            () => {
                this.deactivateShield();
            }
        );

        this.littleGuyCountElement = document.getElementById("little-guy-count");
        this.spawnCostElement = document.getElementById("spawn-cost");
        this.updateSpawnCost();

        this.digsPerDeathElement = document.getElementById("digs-per-death");
        this.updateDigsPerDeath();

        document.querySelector("span.dirt").style.color =
            Pixel.ACTIVE_DIRT_TYPE.color.asCssString();
        document.querySelector("span.dirt-surface").style.color =
            Pixel.ACTIVE_DIRT_TYPE.surfaceColor.asCssString();
        document.querySelector("span.tombstone").style.color =
            PixelConstants.TOMBSTONE_COLOR.asCssString();
        document.querySelector("span.gold").style.color = PixelConstants.GOLD_COLOR.asCssString();
        document.querySelector("span.diamond").style.color =
            PixelConstants.DIAMOND_COLOR.asCssString();
        document.querySelector("span.egg").style.color = PixelConstants.EGG_COLOR.asCssString();
        document.querySelector("span.serpent").style.color =
            PixelConstants.SERPENT_COLOR.asCssString();
        this.updateLegend();
    }

    initMainClickHandler() {
        this.layer.canvas.addEventListener("click", this.handleMouseEvent.bind(this), {
            passive: true,
        });
    }

    calculateZoomLevel(width, height) {
        const pixelBody = this.activePixelBody;
        let objectWidth = 0;
        let objectHeight = 0;
        let objectBufferPct = 0;
        let minZoomLevel = 5;
        let roundingFunc = Math.round;
        if (pixelBody?.layer.initialized) {
            objectWidth = pixelBody.layer.width;
            objectHeight = pixelBody.layer.height;
            objectBufferPct = pixelBody.renderBufferPct;
        } else if (this.gameOverArt?.initialized) {
            objectWidth = GameOverArt.SIZE_PX;
            objectHeight = GameOverArt.SIZE_PX;
            objectBufferPct = 0;
            minZoomLevel = 0;
            roundingFunc = (v) => v;
        } else {
            return 1;
        }

        // Add some buffer around the object to ensure we don't cut off the edges.
        const widthMaxZoom = ((1 - objectBufferPct) * width) / objectWidth;
        const heightMaxZoom = ((1 - objectBufferPct) * height) / objectHeight;
        // Limit ourselves by the smallest max zoom.
        let newZoomLevel = roundingFunc(Math.min(widthMaxZoom, heightMaxZoom));
        newZoomLevel = Math.max(newZoomLevel, minZoomLevel);
        console.log("zoom: " + this.zoomLevel + " -> " + newZoomLevel);
        return newZoomLevel;
    }

    onResize(windowWidth, windowHeight, containerElement) {
        const header = document.getElementById("header");
        const styles = window.getComputedStyle(header);
        const headerMargin = parseFloat(styles["marginTop"]) + parseFloat(styles["marginBottom"]);
        const headerHeight = header.offsetHeight + headerMargin;
        let newWidth = MathExtras.clamp(
            windowWidth - this.WINDOW_SIZE_BUFFER.x,
            this.MIN_WIDTH,
            this.MAX_WIDTH
        );
        let newHeight = MathExtras.clamp(
            windowHeight - headerHeight - this.WINDOW_SIZE_BUFFER.y,
            this.MIN_HEIGHT,
            this.MAX_HEIGHT
        );
        const newZoomLevel = this.calculateZoomLevel(newWidth, newHeight);
        // Round down to the nearest zoom level to ensure the canvas is always a multiple of the
        // zoom level and thus the pixels are always square.
        newWidth = MathExtras.floorToNearest(newZoomLevel, newWidth);
        newHeight = MathExtras.floorToNearest(newZoomLevel, newHeight);
        if (this.width == newWidth && this.height == newHeight) {
            return;
        }

        console.log(
            "Updating canvas dimensions: " +
                this.width +
                " x " +
                this.height +
                " -> " +
                newWidth +
                " x " +
                newHeight
        );
        this.width = newWidth;
        this.height = newHeight;
        this.zoomLevel = newZoomLevel;
        // Don't animate the zoom on resize.
        this.zoomLevelSrc = newZoomLevel;
        this.zoomLevelDst = newZoomLevel;

        // Create a new layer because resizing a canvas makes it blurry.
        if (this.layer) {
            this.layer.destroy();
        }
        this.layer = new Layer("game");
        this.layer.initOnscreen(this.width, this.height, containerElement);
        // Make sure we add the click handler back to the game layer, otherwise... the game
        // is completely broken after the first resize.
        this.initMainClickHandler();
        this.notifyResize();
        this.updateActivePixelBodyPosition();
        if (GameState.isPaused(this.gameState) || GameState.isOver(this.gameState)) {
            this.render();
        }
    }

    notifyResize() {
        const newSize = new Vector(
            this.width / this.zoomLevel,
            this.height / this.zoomLevel
        ).round();
        this.upgradesUi.onResize();
        if (this.particles) {
            this.particles.onResize(newSize);
        }
        this.sky.onResize(newSize);
        this.littleGuys.onResize(newSize);
        for (const pixelBody of this.pixelBodies) {
            pixelBody.onResize(newSize);
        }
    }

    maybeSave() {
        if (this.gameState == GameState.UNINITIALIZED || GameState.isOver(this.gameState)) {
            return;
        }
        if (this.pixelBodies.length <= 1) {
            // Don't save if we're on the final level or the game is over
            return;
        }
        const now = performance.now();
        if (now - this.lastSaved > this.MIN_SAVE_INTERVAL_MS) {
            if (this.gameState === GameState.RUNNING) {
                this.stats.updateRuntime();
            }
            SaveLoad.save(this);
            this.lastSaved = now;
            clearTimeout(this.autoSaveTimeout);
            this.autoSaveTimeout = null;
        } else {
            const remainingTime = this.MIN_SAVE_INTERVAL_MS - (now - this.lastSaved);
            clearTimeout(this.autoSaveTimeout);
            this.autoSaveTimeout = setTimeout(() => this.maybeSave(), remainingTime);
            return;
        }
        if (!this.autoSaveTimeout && this.gameState === GameState.RUNNING) {
            this.autoSaveTimeout = setTimeout(() => this.maybeSave(), this.AUTO_SAVE_INTERVAL_MS);
        }
    }

    updateActivePixelBodyPosition() {
        const activePixelBody = this.activePixelBody;
        if (!activePixelBody || !activePixelBody.layer.initialized) {
            return;
        }
        this.activePixelBodyPosition.set(
            this.width - activePixelBody.layer.width * this.zoomLevel,
            this.height - activePixelBody.layer.height * this.zoomLevel
        );
        // Centered
        this.activePixelBodyPosition.div(2);

        // This makes this method poorly named, but going to update the hourglass position here too
        // because nobody can stop me.
        if (this.hourglass && this.hourglass.initialized) {
            this.hourglassPosition.set(
                this.width - this.hourglass.layer.width * this.zoomLevel,
                this.height - this.hourglass.layer.height * this.zoomLevel
            );
            // Centered
            this.hourglassPosition.div(2);
            this.hourglassPosition.round();
        }
        if (this.zoomLevel == this.zoomLevelDst) {
            // Only round once we've reached the target zoom level, otherwise the zoom is very
            // jittery as the center position gets shifted around a handful of pixels.
            this.activePixelBodyPosition.set(
                MathExtras.floorToNearest(this.zoomLevel, this.activePixelBodyPosition.x),
                MathExtras.floorToNearest(this.zoomLevel, this.activePixelBodyPosition.y)
            );
            this.hourglassPosition.set(
                MathExtras.floorToNearest(this.zoomLevel, this.hourglassPosition.x),
                MathExtras.floorToNearest(this.zoomLevel, this.hourglassPosition.y)
            );
        }
    }

    handleDigsComplete(pixels) {
        if (pixels.length == 0) {
            return;
        }
        this.stats.recordDigs(pixels.length);
        if (!this.knowsDirt) {
            this.knowsDirt = true;
            this.updateLegend();
        }

        let totalValue = 0;
        let includedDiamond = false;
        let includedMagic = false;
        const positionsSum = new Vector();
        for (const pixel of pixels) {
            let value = this.upgrades.aspisPer[pixel.type.name];
            if (
                (pixel.type == PixelType.GOLD && !this.upgrades.unlockGold) ||
                (pixel.type == PixelType.DIAMOND && !this.upgrades.unlockDiamonds)
            ) {
                // Pretend we dug up some dirt if we haven't researched the real type yet.
                value = this.upgrades.aspisPer[PixelType.DIRT.name];
            }
            totalValue += value;

            if (this.upgrades.unlockDiamonds && pixel.type == PixelType.DIAMOND) {
                includedDiamond = true;
            }

            if (pixel.type == PixelType.MAGIC) {
                includedMagic = true;
            }

            positionsSum.add(pixel.position);
        }

        this.aspis += totalValue;
        if (totalValue > 0) {
            this.aspisNeedsUpdate = true;
        }
        const avgPosition = positionsSum.div(pixels.length);
        avgPosition.round();
        const positionInParticlesSpace = this.pixelBodyToParticleSpace(avgPosition);

        const color = new Color(pixels[0].getRenderColor());
        // The pixel itself will likely be invisible post-dig, so make sure we reset the alpha.
        color.a = 255;
        this.particles.digEffect(positionInParticlesSpace, color, this.upgrades.digSpeed);

        this.updateHealth();
        this.updateExpectedValue();

        if (includedDiamond) {
            Story.instance.maybeFirstDiamond();
        }
        if (includedMagic) {
            Story.instance.onMagicDiscovered(() => {
                this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_2).purchase();
            });
        }
        // Check if magic discovery was interrupted.
        if (!Story.instance.magicDiscoveryInProgress && Story.instance.magicDiscoveryInterrupted) {
            Story.instance.onMagicAnalyzed(() => {
                this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_2).purchase();
            });
        }

        const body = this.activePixelBody;
        if (body) {
            if (body.className == CircularPlanet.name) {
                Story.instance.maybeFirstPlanet1(body.health);
                Story.instance.maybeFirstPlanet2(body.health);
            } else if (body.className == SwissPlanet.name) {
                Story.instance.maybeSwissPlanet1(body.health);
            } else if (body.className == SpikyPlanet.name) {
                Story.instance.maybeDeathOfForeman(body.health);
            } else if (body.className == EggPlanet.name) {
                Story.instance.maybeEggPlanet1(body.health);
                Story.instance.maybeEggPlanet2(body.health);
                Story.instance.maybeEggPlanet3(body.health);
                Story.instance.maybeEggPlanet4(body.health);
                Story.instance.maybeEggPlanet5(body.health);
                Story.instance.maybeEggReveal1(body.eggReveal, this.eggRevealCallback);
                Story.instance.maybeEggReveal2(body.eggReveal);

                if (body.eggReveal > 0 && body.isOnlyEggRemaining()) {
                    this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_3).purchase();
                }
            } else if (body.className == Serpent.name) {
                Story.instance.maybeSerpent1(body.health);
                Story.instance.maybeSerpent2(body.health);
                Story.instance.maybeSerpent3(body.health);
            }
        }

        this.maybeSave();
    }

    pixelBodyToParticleSpace(planetCoords) {
        if (!this.activePixelBody) {
            return new Vector();
        }
        const activePixelBody = this.activePixelBody;
        const particleCoords = new Vector(
            this.particles.layer.width / 2 - activePixelBody.layer.width / 2,
            this.particles.layer.height / 2 - activePixelBody.layer.height / 2
        );
        particleCoords.add(planetCoords);
        return particleCoords;
    }

    activateShield() {
        if (this.shieldActive) {
            return;
        }
        if (this.shieldCost > this.aspis) {
            this.startNotEnoughAspisAnimation([this.shieldCostContainerElement]);
            return;
        }
        if (this.littleGuys.length == 0) {
            return;
        }
        this.stopNotEnoughAspisAnimation([this.shieldCostContainerElement]);
        this.aspis -= this.shieldCost;
        this.aspisNeedsUpdate = true;
        this.shieldActive = true;
        Audio.instance.play(Audio.SHIELD_ACTIVATE);

        this.littleGuys.onShieldActivated();

        this.shieldCooldownButton.startCooldown();
    }

    deactivateShield() {
        if (!this.shieldActive) {
            return;
        }
        this.shieldActive = false;
        Audio.instance.play(Audio.SHIELD_DEACTIVATE);

        this.littleGuys.onShieldDeactivated();
    }

    onUpgradePurchased(upgrade, button) {
        const buttonCostEl = document.querySelector(
            "button#" + button.id + " > div.upgrade-title > span.cost"
        );
        if (upgrade.cost > this.aspis) {
            this.startNotEnoughAspisAnimation([
                buttonCostEl,
                this.upgradesAspisElement.parentElement,
            ]);
            return;
        }
        this.stopNotEnoughAspisAnimation([buttonCostEl, this.upgradesAspisElement.parentElement]);
        // Must mark the upgrade as purchased before we update the Aspis, otherwise the 'available
        // to purchase' notifcation bubble will include the one we just purchased.
        upgrade.purchase();
        Audio.instance.play(Audio.UI_UPGRADE_PURCHASED);
        this.aspis -= upgrade.cost;
        if (upgrade.cost > 0) {
            this.aspisNeedsUpdate = true;
        }
        this.updateSpawnCost();
        this.updateDigsPerDeath();
        this.updateLegend();
        if (upgrade.id == Upgrades.SHIELDS_ID) {
            this.shieldCooldownButton.buttonEl.classList.remove("hidden");
        }
        if (this.activePixelBody) {
            // Force the planet to redraw, just in case any new pixel types have been revealed.
            this.activePixelBody.needsUpdate = true;
        }
    }

    maybeBloodDiamondEffect() {
        if (this.upgrades.bloodDiamonds && !this.bloodDiamondEffectShown) {
            this.bloodDiamondEffectShown = true;
            if (this.littleGuys.length > 0) {
                const victim = this.littleGuys.get(0);
                if (victim) {
                    victim.die();
                }
                this.bloodyAround(this.pixelBodyToParticleSpace(victim.positionInPixelBodySpace));
            } else if (this.activePixelBody) {
                const surfacePixel = this.activePixelBody.getRandomSurfacePixel();
                if (surfacePixel) {
                    this.bloodyAround(this.pixelBodyToParticleSpace(surfacePixel.position));
                }
            }
        }
    }

    updateAspis() {
        this.aspisElement.innerHTML = this.aspis;
        this.upgradesAspisElement.innerHTML = this.aspis;
        this.upgradesUi.onAspisChanged(this.aspis);
        this.updatePurchasableUpgradeCount();

        this.maybeSave();
    }

    updatePurchasableUpgradeCount() {
        const purchasableUpgrades = this.upgrades.getPurchasableUpgradeIds(this.aspis);
        if (purchasableUpgrades.length > 0) {
            this.purchasableUpgradeCountEl.classList.remove("hidden");
            this.purchasableUpgradeCountEl.innerHTML = purchasableUpgrades.length;
            Story.instance.maybeIntroduceResearch();
        } else {
            this.purchasableUpgradeCountEl.classList.add("hidden");
        }
    }

    updateHealth() {
        if (GameState.isOver(this.gameState)) {
            return;
        }
        let body = this.activePixelBody;
        let health = 0;

        if (body && body.health <= 0) {
            // Attempt to go to the next pixel body.
            this.goToNextPixelBody();
            body = this.activePixelBody;
        }

        if (body) {
            health = body.health;
        } else {
            Audio.instance.play(Audio.STORY_SERPENT_DEATH);
            this.endGame(true);
        }

        this.healthElement.innerHTML = (100 * health).toFixed(1);
    }

    goToNextPixelBody() {
        const previousPixelBody = this.pixelBodies.shift();
        if (previousPixelBody) {
            previousPixelBody.destroy();
        }
        this.littleGuys.clear();
        if (this.pixelBodies.length == 0 || this.activePixelBody == null) {
            return false;
        }
        this.activePixelBody.init(this.upgrades);
        this.zoomElapsedMs = 0;
        this.notifyResize();
        this.updateActivePixelBodyPosition();
        if (this.activePixelBody.className == Serpent.name) {
            this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_4).purchase();
            // Swap out the planet icon for the serpent
            document.getElementById("planet-icon").classList.add("hidden");
            document.getElementById("serpent-icon").classList.remove("hidden");
            // Initialize the hourglass
            this.hourglass.init(this.finalLevelLost.bind(this));
            // Save once and then prevent further saving.
            this.maybeSave();
            const saveGameBtn = document.getElementById("save-game");
            saveGameBtn.setAttribute("disabled", "");
            // Hide the legend
            document.getElementById("legend").classList.add("hidden");
            document.getElementById("info-container").classList.add("dark");
            Audio.instance.play(Audio.STORY_SERPENT_REVEAL);
        } else {
            // Zooming from the current (zoomed in) point to a more zoomed out point looks kinda goofy,
            // so just have the planet come into view as if we're zooming towards it instead.
            // Just don't do this for the serpent since it's supposed to emerge from an egg.
            this.zoomLevel = 1;
            document.querySelector("span.dirt").style.color =
                Pixel.ACTIVE_DIRT_TYPE.color.asCssString();
            document.querySelector("span.dirt-surface").style.color =
                Pixel.ACTIVE_DIRT_TYPE.surfaceColor.asCssString();
            Audio.instance.play(Audio.NEXT_PLANET);
        }
        this.sky.setColors(this.activePixelBody.skyColors);
        this.zoomLevelSrc = this.zoomLevel;
        this.zoomLevelDst = this.calculateZoomLevel(this.width, this.height);

        this.updateActivePixelBodyPosition();

        if (this.activePixelBody.className == SwissPlanet.name) {
            setTimeout(() => {
                Story.instance.onSwissPlanet();
                this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_1).purchase();
            }, 500);
        } else if (this.activePixelBody.className == SpikyPlanet.name) {
            setTimeout(() => {
                Story.instance.onSpikyPlanet();
            }, 500);
        } else if (this.activePixelBody.className == EggPlanet.name) {
            setTimeout(() => {
                Story.instance.onEggPlanet();
                this.upgrades.getUpgrade(Upgrades.PROGRESS_GATE_ID_2).purchase();
            }, 500);
        } else if (this.activePixelBody.className == Serpent.name) {
            setTimeout(() => {
                Story.instance.onSerpent();
            }, 250);
        }
        return true;
    }

    finalLevelLost() {
        if (!this.activePixelBody || this.activePixelBody.className != Serpent.name) {
            console.error("Not sure how we got here...");
            this.endGame(false);
            return;
        }
        this.activePixelBody.letLoose(this.onSerpentLoose.bind(this));
        this.spawningAllowed = false;
        // Kill all little guys
        this.blood = true;
        this.littleGuys.killAll(2000);
    }

    onSerpentLoose() {
        // There is no next pixel body, so it will be null after this.
        this.goToNextPixelBody();
        this.endGame(false);
    }

    endGame(won) {
        if (this.gameState == GameState.ENDING || GameState.isOver(this.gameState)) {
            return;
        }
        this.gameState = GameState.ENDING;
        this.spawningAllowed = false;
        this.stats.updateRuntime();
        Story.instance.onGameOver(won, () => {
            const showUpgradesBtn = document.getElementById("show-upgrades");
            showUpgradesBtn.classList.add("hidden");
            const infoContainer = document.getElementById("info-container");
            infoContainer.classList.add("hidden");
            this.shieldCooldownButton.buttonEl.classList.add("hidden");
            const pauseBtn = document.getElementById("pause-resume");
            pauseBtn.setAttribute("disabled", "");
            this.showGameOverScreen(won);
        });
    }

    showGameOverScreen(won) {
        // Stop rendering the hourglass.
        this.hourglass.initialized = false;
        this.gameOverArt.initialize(won, () => {
            this.zoomLevel = 200;
            this.zoomLevelSrc = this.zoomLevel;
            this.zoomLevelDst = this.calculateZoomLevel(this.width, this.height);
        });
    }

    endGameForRealForReal(won) {
        this.gameState = won ? GameState.WON : GameState.LOST;
        Story.instance.thanks(this.stats, Math.round(this.upgrades.karma));
    }

    updateLegend() {
        for (const pixelType of Object.values(PixelType)) {
            if (pixelType == PixelType.MAGIC) {
                continue;
            }
            document.getElementById("aspis-per-" + pixelType.name).innerText =
                this.upgrades.aspisPer[pixelType.name];
        }

        const updateHidden = function (type, show) {
            const element = document.querySelector("span." + type.name.toLowerCase()).parentElement;
            if (show) {
                element.classList.remove("hidden");
            } else {
                element.classList.add("hidden");
            }
        };
        updateHidden(PixelType.DIRT, this.knowsDirt);
        updateHidden(PixelType.TOMBSTONE, this.knowsDeath);
        updateHidden(PixelType.GOLD, this.upgrades.unlockGold);
        updateHidden(PixelType.DIAMOND, this.upgrades.unlockDiamonds);
        updateHidden(PixelType.EGG, this.knowsEggDeath || this.upgrades.eggHandling);

        const eggSpan = document.querySelector(
            "span#" + PixelType.EGG.name.toLowerCase() + "-legend-title"
        );
        if (this.upgrades.eggHandling) {
            eggSpan.innerText = "Egg";
        }
    }

    gameToActiveBodyCoords(gameCoords) {
        return new Vector(
            (gameCoords.x - this.activePixelBodyPosition.x) / this.zoomLevel,
            (gameCoords.y - this.activePixelBodyPosition.y) / this.zoomLevel
        ).round();
    }

    handleMouseEvent(event) {
        if (event.button != 0 || GameState.isPaused(this.gameState)) {
            return;
        }

        const gameCoords = new Vector(event.offsetX, event.offsetY);
        const activeBodyCoords = this.gameToActiveBodyCoords(gameCoords);
        if (window.DEBUG_MODE) {
            console.log(
                "Translating mouse click @ " +
                    gameCoords.toString() +
                    " to " +
                    activeBodyCoords.toString()
            );
        }
        if (!this.activePixelBody) {
            return;
        }
        this.stats.recordClick();
        const closestSurfacePixel = this.activePixelBody.getClosestSurfacePixel(activeBodyCoords);
        if (!closestSurfacePixel) {
            return;
        }
        this.spawn(closestSurfacePixel.position, false);
    }

    get activePixelBody() {
        return this.pixelBodies.length > 0 ? this.pixelBodies[0] : null;
    }

    startNotEnoughAspisAnimation(others) {
        const animated = [this.aspisElement.parentElement];
        if (others) {
            animated.push(...others);
        }
        CssEffects.startPulseAnimation(animated);
    }

    stopNotEnoughAspisAnimation(others) {
        const animated = [this.aspisElement.parentElement];
        if (others) {
            animated.push(...others);
        }
        CssEffects.stopPulseAnimation(animated);
    }

    spawn(position, immaculate) {
        if (!this.spawningAllowed) {
            return;
        }
        if (!immaculate) {
            if (this.spawnCost > this.aspis) {
                this.startNotEnoughAspisAnimation([this.spawnCostElement.parentElement]);
                return;
            }
            this.stopNotEnoughAspisAnimation([this.spawnCostElement.parentElement]);
        }
        if (this.littleGuys.length >= this.MAX_LITTLE_GUYS) {
            if (!immaculate) {
                CssEffects.startPulseAnimation([this.littleGuyCountElement.parentElement]);
                return;
            }
            CssEffects.stopPulseAnimation([this.littleGuyCountElement.parentElement]);
        }

        if (!this.activePixelBody) {
            return;
        }
        const littleGuy = this.littleGuys.spawn(
            this.activePixelBody,
            position,
            this.upgrades,
            immaculate
        );
        if (this.shieldActive) {
            littleGuy.shielded = true;
        }
        if (!immaculate) {
            this.aspis -= this.spawnCost;
            if (this.spawnCost > 0) {
                this.aspisNeedsUpdate = true;
            }
            if (Math.random() < this.upgrades.extraLittleGuyChance) {
                const randomSurfacePixel = this.activePixelBody.getRandomSurfacePixel();
                if (!randomSurfacePixel) {
                    return;
                }
                this.spawn(randomSurfacePixel.position, true);
            }
        }
        this.updateSpawnCost();
        this.maybeSave();
    }

    updateSpawnCost() {
        const paidForCount = Math.max(
            0,
            this.littleGuys.maculateCount + 1 - this.upgrades.freeWorkerCount
        );
        this.spawnCost = Math.floor(paidForCount ** this.upgrades.populationPowerScale);
        this.spawnCostElement.innerHTML = this.spawnCost;
        this.littleGuyCountElement.innerHTML = this.littleGuys.length;

        // Piggy back on this to also update the shield cost.
        if (this.upgrades.shieldsUnlocked) {
            this.shieldCost = this.littleGuys.aliveCount * this.SHIELD_COST_PER_LITTLE_GUY;
            if (this.shieldCost == 0) {
                this.shieldCooldownButton.buttonEl.disabled = true;
            } else if (!this.shieldCooldownButton.isCooldownInProgress) {
                this.shieldCooldownButton.buttonEl.disabled = false;
            }
            this.shieldCostElement.innerHTML = this.shieldCost;
        }
    }

    updateDigsPerDeath() {
        this.digsPerDeathElement.innerHTML = this.upgrades.digCount;
        this.updateExpectedValue();
    }

    updateExpectedValue() {
        if (!this.upgrades.showWorkerEV) {
            return;
        }
        const evContainer = document.getElementById("worker-ev-container");
        evContainer.classList.remove("hidden");
        const evSpan = document.getElementById("worker-ev");
        this.workerEv = Math.round(this.calculateExpectedValue());
        evSpan.innerHTML = this.workerEv;
    }

    calculateExpectedValue() {
        const body = this.activePixelBody;
        if (!body) {
            return 0;
        }
        // Looking at the surface of the planet, we can average out the value of each pixel and
        // multiply that by the number of digs each little guy will perform to get an estimate of
        // the EV of spawning a new little guy.
        const surface = body.surfacePixels;
        if (surface.length == 0) {
            return 0;
        }
        let totalValue = 0;
        for (let i = 0; i < surface.length; i++) {
            const surfacePixel = surface[i];
            if (!surfacePixel) {
                continue;
            }
            let pixelType = surfacePixel.type;
            if (pixelType == PixelType.GOLD && !this.upgrades.unlockGold) {
                pixelType = PixelType.DIRT;
            } else if (pixelType == PixelType.DIAMOND && !this.upgrades.unlockDiamonds) {
                pixelType = PixelType.DIRT;
            } else if (pixelType == PixelType.EGG && !this.upgrades.eggHandling) {
                // Can't dig this yet, so it effectively contributes 0 value.
                continue;
            }
            totalValue += this.upgrades.aspisPer[pixelType.name];
        }
        const avgValue = totalValue / surface.length;
        const expectedValue = avgValue * this.upgrades.digCount;
        return expectedValue;
    }

    // Center is in planet space
    bloodyAround(center) {
        this.particles.bloodEffect(this.pixelBodyToParticleSpace(center));
        if (!this.activePixelBody) {
            return;
        }
        const radius = Math.round(MathExtras.randomBetween(2, 4));
        for (let x = center.x - radius; x < center.x + radius; x++) {
            for (let y = center.y - radius; y < center.y + radius; y++) {
                const dist = new Vector(center.x - x, center.y - y).mag();
                if (dist > radius) {
                    continue;
                }
                const pixel = this.activePixelBody.getPixel(new Vector(x, y));
                if (!pixel || !pixel.isSurface || pixel.isBloodied) {
                    continue;
                }
                pixel.bloody();
            }
        }
    }

    handleDeath(littleGuy) {
        if (!this.knowsDeath) {
            this.knowsDeath = true;
            this.updateLegend();
        }
        Story.instance.maybeForemansSonDead();
        if (this.upgrades.afterlife) {
            if (littleGuy.saintly) {
                this.upgrades.updateKarma(1 / 3);
            } else {
                this.upgrades.updateKarma(-1);
            }
            this.aspis += this.upgrades.aspisPer[PixelType.TOMBSTONE.name];
            this.aspisNeedsUpdate = true;
        }
        if (this.upgrades.aspisOnDeathAsEvRate > 0) {
            this.aspis += Math.round(this.workerEv * this.upgrades.aspisOnDeathAsEvRate);
            this.aspisNeedsUpdate = true;
        }
        if (littleGuy.deathByEgg) {
            this.knowsEggDeath = true;
            this.particles.fireEffect(
                this.pixelBodyToParticleSpace(littleGuy.positionInPixelBodySpace)
            );
            this.updateLegend();
        } else if (littleGuy.explosive) {
            this.particles.explosionEffect(
                this.pixelBodyToParticleSpace(littleGuy.positionInPixelBodySpace)
            );
        } else if (littleGuy.deathBySerpent) {
            this.particles.bloodEffect(
                this.pixelBodyToParticleSpace(littleGuy.positionInPixelBodySpace)
            );
        }

        if (this.blood) {
            this.bloodyAround(littleGuy);
        }
    }

    handleInactive() {
        this.stats.recordDeath();
        this.updateSpawnCost();
        if (this.activePixelBody instanceof Planet) {
            this.activePixelBody.updateDarkness();
        }
    }

    maybeAutoSpawn() {
        const activePixelBody = this.activePixelBody;
        if (!activePixelBody) {
            return;
        }
        if (
            this.upgrades.conceptionIntervalMs > 0 &&
            this.now - this.lastConceptionTime > this.upgrades.conceptionIntervalMs
        ) {
            console.log("Immaculate conception occurred");
            const pixelBodyCoords = new Vector(
                Math.random() * activePixelBody.layer.width,
                Math.random() * activePixelBody.layer.height
            );
            const closestSurfacePixel = activePixelBody.getClosestSurfacePixel(pixelBodyCoords);
            if (closestSurfacePixel) {
                this.spawn(closestSurfacePixel.position, true);
            }

            this.lastConceptionTime = this.now;
        }
    }

    setPaused(paused) {
        if (this.gameState == GameState.UNINITIALIZED || GameState.isOver(this.gameState)) {
            return;
        }
        if (GameState.isPaused(this.gameState) == paused) {
            return;
        }
        this.gameState = paused ? GameState.PAUSED : GameState.RUNNING;
        if (!paused) {
            this.then = window.performance.now();
            this.tick(this.then);
            this.stats.resetLastUpdateTime();
            Dialogs.resume();
            this.shieldCooldownButton.resumeCooldown();
        } else {
            this.stats.updateRuntime();
            Dialogs.pause();
            this.shieldCooldownButton.pauseCooldown();
        }
        this.maybeSave();
    }

    tick(newtime) {
        if (
            GameState.isPaused(this.gameState) ||
            GameState.isOver(this.gameState) ||
            !this.layer.canvas
        ) {
            return;
        }

        requestAnimationFrame(this.tick.bind(this));
        this.now = newtime;
        const elapsedMs = this.now - this.then;

        if (elapsedMs <= this.FRAME_INTERVAL_MS) {
            return;
        }
        this.then = this.now - (elapsedMs % this.FRAME_INTERVAL_MS);

        if (window.DEBUG) {
            this.perfStats.begin();
        }
        for (let i = 0; i < window.GAME_SPEED; i++) {
            this.runUpdate(elapsedMs);
        }
        this.render(elapsedMs);
        if (window.DEBUG) {
            this.perfStats.end();
        }
    }

    runUpdate(elapsedMs) {
        // Only update the aspis once per frame at most, otherwise it gets too expensive.
        // Multiple aspis changes can happen in a single frame (e.g. death + dig).
        if (this.aspisNeedsUpdate) {
            this.updateAspis();
            this.aspisNeedsUpdate = false;
        }

        this.maybeAutoSpawn();

        this.sky.update();

        if (this.hourglass.initialized) {
            this.hourglass.update(elapsedMs);
        }

        if (this.activePixelBody) {
            this.activePixelBody.update(elapsedMs);
        }

        this.littleGuys.update();

        if (this.gameOverArt.initialized) {
            this.gameOverArt.update();
            if (this.zoomLevel == this.zoomLevelDst) {
                this.endGameForRealForReal(this.gameOverArt.won);
            }
        }

        // Don't do particles on higher game speeds (used for testing only)
        if (window.GAME_SPEED == 1) {
            this.particles.update();
        }
    }

    render(elapsedMs) {
        // Handle zoom updates first
        if (this.zoomLevelSrc >= 0) {
            if (
                Math.abs(this.zoomLevel - this.zoomLevelDst) < 0.01 ||
                this.zoomLevelDst == this.zoomLevelSrc
            ) {
                // Zoom complete
                this.zoomLevel = this.zoomLevelDst;
                this.updateActivePixelBodyPosition();
                this.zoomLevelSrc = -1;
            } else {
                this.zoomElapsedMs += elapsedMs;
                const durationMs = this.gameOverArt.initialized
                    ? this.GAME_OVER_ZOOM_DURATION_MS
                    : this.ZOOM_DURATION_MS;
                const zoomProgress = this.zoomElapsedMs / durationMs;
                this.zoomLevel = MathExtras.easeOutCubic(
                    this.zoomLevelSrc,
                    this.zoomLevelDst,
                    zoomProgress
                );
                this.notifyResize();
                this.updateActivePixelBodyPosition();
            }
        }

        this.layer.getContext().fillStyle = "white";
        this.layer.getContext().fillRect(0, 0, this.width, this.height);

        if (this.sky.layer?.initialized) {
            this.layer.getContext().drawImage(
                this.sky.layer.canvas,
                0, // source x
                0, // source y
                this.sky.layer.width, // source width
                this.sky.layer.height, // source height
                // The sky layer shares the same size as the main canvas, so no need to
                // translate.
                (-this.sky.layer.width * this.zoomLevel) / 4, // destination x
                0, // destination y
                this.sky.layer.width * this.zoomLevel, // destination width
                this.sky.layer.height * this.zoomLevel // destination height
            );
        }
        if (this.hourglass.layer?.initialized && !this.gameOverArt.layer?.initialized) {
            this.layer.getContext().drawImage(
                this.hourglass.layer.canvas,
                0, // source x
                0, // source y
                this.hourglass.layer.width, // source width
                this.hourglass.layer.height, // source height
                this.hourglassPosition.x, // destination x
                this.hourglassPosition.y, // destination y
                this.hourglass.layer.width * this.zoomLevel, // destination width
                this.hourglass.layer.height * this.zoomLevel // destination height
            );
        }
        const pixelBody = this.activePixelBody;
        if (pixelBody && pixelBody.layer?.initialized) {
            this.layer.getContext().drawImage(
                pixelBody.layer.canvas,
                0, // source x
                0, // source y
                pixelBody.layer.width, // source width
                pixelBody.layer.height, // source height
                this.activePixelBodyPosition.x, // destination x
                this.activePixelBodyPosition.y, // destination y
                pixelBody.layer.width * this.zoomLevel, // destination width
                pixelBody.layer.height * this.zoomLevel // destination height
            );
        }
        if (this.littleGuys.initialized) {
            this.littleGuys.updateRenderData(this.activePixelBodyPosition, this.zoomLevel);
            this.layer.getContext().drawImage(
                this.littleGuys.layer.canvas,
                0, // source x
                0, // source y
                this.littleGuys.layer.width, // source width
                this.littleGuys.layer.height, // source height
                // The littleGuys layer shares the same size as the main canvas, so no need to
                // translate.
                0, // destination x
                0, // destination y
                this.littleGuys.layer.width * this.zoomLevel, // destination width
                this.littleGuys.layer.height * this.zoomLevel // destination height
            );
        }
        // for (const littleGuy of this.littleGuys) {
        //     if (!littleGuy.active || !littleGuy.layer?.initialized) {
        //         continue;
        //     }
        //     this.layer.getContext().drawImage(
        //         littleGuy.layer.canvas,
        //         0, // source x
        //         0, // source y
        //         littleGuy.layer.width, // source width
        //         littleGuy.layer.height, // source height
        //         this.activePixelBodyPosition.x +
        //             (Math.round(littleGuy.positionInPixelBodySpace.x) - littleGuy.center.x) *
        //                 this.zoomLevel, // destination x
        //         this.activePixelBodyPosition.y +
        //             (Math.round(littleGuy.positionInPixelBodySpace.y) - littleGuy.center.y) *
        //                 this.zoomLevel, // destination y
        //         littleGuy.layer.width * this.zoomLevel, // destination width
        //         littleGuy.layer.height * this.zoomLevel // destination height
        //     );
        // }
        if (this.gameOverArt.layer?.initialized) {
            this.layer.getContext().drawImage(
                this.gameOverArt.layer.canvas,
                0, // source x
                0, // source y
                this.gameOverArt.layer.width, // source width
                this.gameOverArt.layer.height, // source height
                (this.layer.width - this.gameOverArt.layer.width * this.zoomLevel) / 2, // destination x
                (this.layer.height - this.gameOverArt.layer.height * this.zoomLevel) / 2, // destination y
                this.gameOverArt.layer.width * this.zoomLevel, // destination width
                this.gameOverArt.layer.height * this.zoomLevel // destination height
            );
        }
        // Render particles last as they go on top of everything else.
        // Don't do particles on higher game speeds (used for testing only).
        if (window.GAME_SPEED == 1 && this.particles.layer?.initialized) {
            this.layer.getContext().drawImage(
                this.particles.layer.canvas,
                0, // source x
                0, // source y
                this.particles.layer.width, // source width
                this.particles.layer.height, // source height
                // The particles layer shares the same size as the main canvas, so no need to
                // translate.
                0, // destination x
                0, // destination y
                this.particles.layer.width * this.zoomLevel, // destination width
                this.particles.layer.height * this.zoomLevel // destination height
            );
        }
    }
}
