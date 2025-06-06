// Copyright (c) 2025 Alexander Douglas
// Licensed under the MIT License.
// See LICENSE file in the project root for full license information.

import Color from "../color.js";
import MathExtras from "../math_extras.js";
import Constants from "./constants.js";

// Not really a general-purpose pixel. These are the pixels that make up the planet and can be dug.
export default class Pixel {
    // Can be used to tweak when damage actually gets reflected in the alpha of the pixel. A value
    // of 1 means any amount of damage gets shown immediately.
    static HEALTH_VISUAL_PCT_INTERVAL = 1;

    static DIRT = {
        name: "dirt",
        color: Constants.DIRT_COLOR,
        surfaceColor: Constants.DIRT_SURFACE_COLOR,
    };
    static GOOP_DIRT = {
        name: "goop",
        color: Constants.GOOP_DIRT_COLOR,
        surfaceColor: Constants.GOOP_DIRT_SURFACE_COLOR,
    };
    static ICE_DIRT = {
        name: "ice",
        color: Constants.ICE_DIRT_COLOR,
        surfaceColor: Constants.ICE_DIRT_SURFACE_COLOR,
    };
    // Default to regular dirt.
    static ACTIVE_DIRT_TYPE = Pixel.DIRT;

    static setDirtType(dirtType) {
        Pixel.ACTIVE_DIRT_TYPE = dirtType;
    }

    constructor(position, upgrades, type, initialHealth, healthModifier = 1, initialAlpha = 255) {
        this.position = position.copy();
        this.position.round();
        this.upgrades = upgrades;
        this.type = type;
        this.initialHealth = initialHealth * healthModifier;
        this.health = this.initialHealth;
        this.healthModifier = healthModifier;
        this.initialAlpha = initialAlpha;

        this.color = null;
        this.surfaceColor = null;
        this.colorOverride = null;

        this.isSurface = false;
        // 0-1, where 0 is no change to the color, 1 is fully black
        this.darkness = 0;
        this.bloodiedColor = null;

        this.needsUpdate = true;
    }

    toJSON() {
        return {
            position: this.position,
            typeName: this.type.name,
            color: this.color,
            surfaceColor: this.surfaceColor,
            health: this.health,
            healthModifier: this.healthModifier,
            isSurface: this.isSurface,
            colorOverride: this.colorOverride,
            darkness: this.darkness,
        };
    }

    getDirtColor() {
        return Pixel.ACTIVE_DIRT_TYPE.color;
    }

    getDirtSurfaceColor() {
        return Pixel.ACTIVE_DIRT_TYPE.surfaceColor;
    }

    actLikeDirt() {
        throw Exception("Must be implemented by child class");
    }

    getRenderColor() {
        if (this.bloodiedColor) {
            return this.bloodiedColor;
        }
        if (this.actLikeDirt()) {
            return this.isSurface ? this.getDirtSurfaceColor() : this.getDirtColor();
        }
        return this.isSurface ? this.surfaceColor : this.color;
    }

    getRenderAlpha() {
        let maxAlpha = this.initialAlpha;
        let actLikeDirtDiff = this.actLikeDirt()
            ? this.initialHealth - Constants.DIRT_INITIAL_HEALTH * this.healthModifier
            : 0;
        let healthPct =
            (100 * (this.health - actLikeDirtDiff)) / (this.initialHealth - actLikeDirtDiff);
        healthPct = MathExtras.ceilToNearest(Pixel.HEALTH_VISUAL_PCT_INTERVAL, healthPct);
        return (maxAlpha * healthPct) / 100;
    }

    render(imageData) {
        this.needsUpdate = false;
        let renderPosition = this.position;
        if (renderPosition.x < 0 || renderPosition.x >= imageData.width) {
            return;
        }
        if (renderPosition.y < 0 || renderPosition.y >= imageData.height) {
            return;
        }
        let pixelIndex = (renderPosition.x + renderPosition.y * imageData.width) * 4;
        let color = this.hasColorOverride() ? this.colorOverride : this.getRenderColor();
        let darkness = window.DEBUG_MODE ? 0 : this.darkness;
        imageData.data[pixelIndex] = Math.round(color.r * (1 - darkness)); // Red
        imageData.data[pixelIndex + 1] = Math.round(color.g * (1 - darkness)); // Green
        imageData.data[pixelIndex + 2] = Math.round(color.b * (1 - darkness)); // Blue
        let alpha = this.getRenderAlpha();
        imageData.data[pixelIndex + 3] = Math.round(alpha); // Alpha
    }

    damage(damage) {
        let alphaBefore = this.getRenderAlpha();
        this.health = Math.max(0, this.health - damage);
        let alphaAfter = this.getRenderAlpha();
        if (alphaBefore !== alphaAfter) {
            this.needsUpdate = true;
        }
    }

    setColorOverride(color) {
        this.colorOverride = color;
    }

    unsetColorOverride() {
        this.colorOverride = null;
    }

    hasColorOverride() {
        return this.colorOverride !== null;
    }

    // Accounts for if we're acting like dirt.
    getHealth() {
        if (!this.actLikeDirt()) {
            return this.health;
        }
        let actLikeDirtDiff =
            this.initialHealth - Constants.DIRT_INITIAL_HEALTH * this.healthModifier;
        return Math.max(0, this.health - actLikeDirtDiff);
    }

    setSurface(isSurface) {
        this.isSurface = isSurface;
    }

    setOpacity(opacity) {
        let alpha = MathExtras.clamp(opacity, 0, 1) * this.initialAlpha;
        this.color.a = alpha;
        this.surfaceColor.a = alpha;
    }

    bloody() {
        if (this.bloodiedColor) {
            return;
        }
        this.bloodiedColor = Color.wiggle(Color.BLOOD, 10);
        this.needsUpdate = true;
    }

    setDarkness(darkness) {
        this.darkness = MathExtras.clamp(darkness, 0, 1);
    }

    get isBloodied() {
        return !!this.bloodiedColor;
    }

    // Needed for quad tree
    get x() {
        return this.position.x;
    }

    get y() {
        return this.position.y;
    }

    get width() {
        return 1;
    }

    get height() {
        return 1;
    }

    get surface() {
        return this.isSurface;
    }
}
