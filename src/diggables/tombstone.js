// Copyright (c) 2025 Alexander Douglas
// Licensed under the MIT License.
// See LICENSE file in the project root for full license information.

import Color from "../color.js";
import Constants from "./constants.js";
import Pixel from "./pixel.js";
import PixelType from "./pixel_type.js";

export default class Tombstone extends Pixel {
    static COLOR_VARIABILITY = 5;
    static DARKNESS_HIDE_THRESHOLD = 0.15;

    static HEALTH = 125;

    constructor(position, upgrades, healthModifier = 1) {
        super(position, upgrades, PixelType.TOMBSTONE, Tombstone.HEALTH, healthModifier);

        this.color = Color.wiggle(Constants.TOMBSTONE_COLOR, Tombstone.COLOR_VARIABILITY);
        this.surfaceColor = this.color.copy();
    }

    actLikeDirt() {
        return false;
    }
}
