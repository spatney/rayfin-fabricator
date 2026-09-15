//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Bundled demo dataset for the **starter dashboard** (`src/demo/DemoDashboard.tsx`).
 *
 * This is REAL public data — the classic Gapminder "five-year" panel: life
 * expectancy, GDP per capita (inflation-adjusted international dollars), and
 * population for 26 countries across 5 regions, at 5-year intervals from 1952 to
 * 2007. Source: Gapminder (https://www.gapminder.org/data/), via the `gapminder`
 * dataset (plotly/datasets, CC-BY 4.0). A curated slice is embedded so the starter
 * renders a complete, interactive dashboard out of the box with no data connection.
 *
 * ⚠️ This is starter/demo data, deliberately shipped so the template looks alive on
 * first run. When you build your real app, DELETE `src/demo/**`, connect a Power BI
 * semantic model in `fabric.yaml`, query it with DAX, map the result with
 * `toChartData` / `toTable`, and author your own specs (see `AGENTS.md`). The live
 * app should never ship placeholder data.
 *
 * All fields are plain numbers so the rows drop straight into Graphein specs and
 * the client-side `applyFilters` helper (which keys rows by the field short name —
 * so a filter on `"region"` reads the `region` key, `"country"` → `country`, etc.).
 */

import type { SlicerOption } from "@/components/dashboard";

/** One country's indicators for a single year (tidy / long — one row per country × year). */
export type DevRow = {
    /** Country display name. */
    country: string;
    /** Region / continent — one of {@link REGIONS}. */
    region: string;
    /** Calendar year (5-year steps, {@link EARLIEST_YEAR}…{@link LATEST_YEAR}). */
    year: number;
    /** Life expectancy at birth, in years. */
    lifeExp: number;
    /** GDP per capita, inflation-adjusted international dollars. */
    gdpPercap: number;
    /** Total population (people). */
    pop: number;
}

/**
 * The embedded Gapminder slice (sorted by region, then country, then year).
 * 26 countries × 12 years = 312 rows.
 */
export const DEV_DATA: readonly DevRow[] = [
    { country: "Egypt", region: "Africa", year: 1952, lifeExp: 41.9, gdpPercap: 1419, pop: 22223309 },
    { country: "Egypt", region: "Africa", year: 1957, lifeExp: 44.4, gdpPercap: 1459, pop: 25009741 },
    { country: "Egypt", region: "Africa", year: 1962, lifeExp: 47, gdpPercap: 1693, pop: 28173309 },
    { country: "Egypt", region: "Africa", year: 1967, lifeExp: 49.3, gdpPercap: 1815, pop: 31681188 },
    { country: "Egypt", region: "Africa", year: 1972, lifeExp: 51.1, gdpPercap: 2024, pop: 34807417 },
    { country: "Egypt", region: "Africa", year: 1977, lifeExp: 53.3, gdpPercap: 2785, pop: 38783863 },
    { country: "Egypt", region: "Africa", year: 1982, lifeExp: 56, gdpPercap: 3504, pop: 45681811 },
    { country: "Egypt", region: "Africa", year: 1987, lifeExp: 59.8, gdpPercap: 3885, pop: 52799062 },
    { country: "Egypt", region: "Africa", year: 1992, lifeExp: 63.7, gdpPercap: 3795, pop: 59402198 },
    { country: "Egypt", region: "Africa", year: 1997, lifeExp: 67.2, gdpPercap: 4173, pop: 66134291 },
    { country: "Egypt", region: "Africa", year: 2002, lifeExp: 69.8, gdpPercap: 4755, pop: 73312559 },
    { country: "Egypt", region: "Africa", year: 2007, lifeExp: 71.3, gdpPercap: 5581, pop: 80264543 },
    { country: "Ethiopia", region: "Africa", year: 1952, lifeExp: 34.1, gdpPercap: 362, pop: 20860941 },
    { country: "Ethiopia", region: "Africa", year: 1957, lifeExp: 36.7, gdpPercap: 379, pop: 22815614 },
    { country: "Ethiopia", region: "Africa", year: 1962, lifeExp: 40.1, gdpPercap: 419, pop: 25145372 },
    { country: "Ethiopia", region: "Africa", year: 1967, lifeExp: 42.1, gdpPercap: 516, pop: 27860297 },
    { country: "Ethiopia", region: "Africa", year: 1972, lifeExp: 43.5, gdpPercap: 566, pop: 30770372 },
    { country: "Ethiopia", region: "Africa", year: 1977, lifeExp: 44.5, gdpPercap: 557, pop: 34617799 },
    { country: "Ethiopia", region: "Africa", year: 1982, lifeExp: 44.9, gdpPercap: 578, pop: 38111756 },
    { country: "Ethiopia", region: "Africa", year: 1987, lifeExp: 46.7, gdpPercap: 574, pop: 42999530 },
    { country: "Ethiopia", region: "Africa", year: 1992, lifeExp: 48.1, gdpPercap: 421, pop: 52088559 },
    { country: "Ethiopia", region: "Africa", year: 1997, lifeExp: 49.4, gdpPercap: 516, pop: 59861301 },
    { country: "Ethiopia", region: "Africa", year: 2002, lifeExp: 50.7, gdpPercap: 530, pop: 67946797 },
    { country: "Ethiopia", region: "Africa", year: 2007, lifeExp: 52.9, gdpPercap: 691, pop: 76511887 },
    { country: "Ghana", region: "Africa", year: 1952, lifeExp: 43.1, gdpPercap: 911, pop: 5581001 },
    { country: "Ghana", region: "Africa", year: 1957, lifeExp: 44.8, gdpPercap: 1044, pop: 6391288 },
    { country: "Ghana", region: "Africa", year: 1962, lifeExp: 46.5, gdpPercap: 1190, pop: 7355248 },
    { country: "Ghana", region: "Africa", year: 1967, lifeExp: 48.1, gdpPercap: 1126, pop: 8490213 },
    { country: "Ghana", region: "Africa", year: 1972, lifeExp: 49.9, gdpPercap: 1178, pop: 9354120 },
    { country: "Ghana", region: "Africa", year: 1977, lifeExp: 51.8, gdpPercap: 993, pop: 10538093 },
    { country: "Ghana", region: "Africa", year: 1982, lifeExp: 53.7, gdpPercap: 876, pop: 11400338 },
    { country: "Ghana", region: "Africa", year: 1987, lifeExp: 55.7, gdpPercap: 847, pop: 14168101 },
    { country: "Ghana", region: "Africa", year: 1992, lifeExp: 57.5, gdpPercap: 925, pop: 16278738 },
    { country: "Ghana", region: "Africa", year: 1997, lifeExp: 58.6, gdpPercap: 1005, pop: 18418288 },
    { country: "Ghana", region: "Africa", year: 2002, lifeExp: 58.5, gdpPercap: 1112, pop: 20550751 },
    { country: "Ghana", region: "Africa", year: 2007, lifeExp: 60, gdpPercap: 1328, pop: 22873338 },
    { country: "Kenya", region: "Africa", year: 1952, lifeExp: 42.3, gdpPercap: 854, pop: 6464046 },
    { country: "Kenya", region: "Africa", year: 1957, lifeExp: 44.7, gdpPercap: 944, pop: 7454779 },
    { country: "Kenya", region: "Africa", year: 1962, lifeExp: 47.9, gdpPercap: 897, pop: 8678557 },
    { country: "Kenya", region: "Africa", year: 1967, lifeExp: 50.7, gdpPercap: 1057, pop: 10191512 },
    { country: "Kenya", region: "Africa", year: 1972, lifeExp: 53.6, gdpPercap: 1222, pop: 12044785 },
    { country: "Kenya", region: "Africa", year: 1977, lifeExp: 56.2, gdpPercap: 1268, pop: 14500404 },
    { country: "Kenya", region: "Africa", year: 1982, lifeExp: 58.8, gdpPercap: 1348, pop: 17661452 },
    { country: "Kenya", region: "Africa", year: 1987, lifeExp: 59.3, gdpPercap: 1362, pop: 21198082 },
    { country: "Kenya", region: "Africa", year: 1992, lifeExp: 59.3, gdpPercap: 1342, pop: 25020539 },
    { country: "Kenya", region: "Africa", year: 1997, lifeExp: 54.4, gdpPercap: 1360, pop: 28263827 },
    { country: "Kenya", region: "Africa", year: 2002, lifeExp: 51, gdpPercap: 1288, pop: 31386842 },
    { country: "Kenya", region: "Africa", year: 2007, lifeExp: 54.1, gdpPercap: 1463, pop: 35610177 },
    { country: "Nigeria", region: "Africa", year: 1952, lifeExp: 36.3, gdpPercap: 1077, pop: 33119096 },
    { country: "Nigeria", region: "Africa", year: 1957, lifeExp: 37.8, gdpPercap: 1101, pop: 37173340 },
    { country: "Nigeria", region: "Africa", year: 1962, lifeExp: 39.4, gdpPercap: 1151, pop: 41871351 },
    { country: "Nigeria", region: "Africa", year: 1967, lifeExp: 41, gdpPercap: 1015, pop: 47287752 },
    { country: "Nigeria", region: "Africa", year: 1972, lifeExp: 42.8, gdpPercap: 1698, pop: 53740085 },
    { country: "Nigeria", region: "Africa", year: 1977, lifeExp: 44.5, gdpPercap: 1982, pop: 62209173 },
    { country: "Nigeria", region: "Africa", year: 1982, lifeExp: 45.8, gdpPercap: 1577, pop: 73039376 },
    { country: "Nigeria", region: "Africa", year: 1987, lifeExp: 46.9, gdpPercap: 1385, pop: 81551520 },
    { country: "Nigeria", region: "Africa", year: 1992, lifeExp: 47.5, gdpPercap: 1620, pop: 93364244 },
    { country: "Nigeria", region: "Africa", year: 1997, lifeExp: 47.5, gdpPercap: 1625, pop: 106207839 },
    { country: "Nigeria", region: "Africa", year: 2002, lifeExp: 46.6, gdpPercap: 1615, pop: 119901274 },
    { country: "Nigeria", region: "Africa", year: 2007, lifeExp: 46.9, gdpPercap: 2014, pop: 135031164 },
    { country: "South Africa", region: "Africa", year: 1952, lifeExp: 45, gdpPercap: 4725, pop: 14264935 },
    { country: "South Africa", region: "Africa", year: 1957, lifeExp: 48, gdpPercap: 5487, pop: 16151549 },
    { country: "South Africa", region: "Africa", year: 1962, lifeExp: 50, gdpPercap: 5769, pop: 18356657 },
    { country: "South Africa", region: "Africa", year: 1967, lifeExp: 51.9, gdpPercap: 7114, pop: 20997321 },
    { country: "South Africa", region: "Africa", year: 1972, lifeExp: 53.7, gdpPercap: 7766, pop: 23935810 },
    { country: "South Africa", region: "Africa", year: 1977, lifeExp: 55.5, gdpPercap: 8029, pop: 27129932 },
    { country: "South Africa", region: "Africa", year: 1982, lifeExp: 58.2, gdpPercap: 8568, pop: 31140029 },
    { country: "South Africa", region: "Africa", year: 1987, lifeExp: 60.8, gdpPercap: 7826, pop: 35933379 },
    { country: "South Africa", region: "Africa", year: 1992, lifeExp: 61.9, gdpPercap: 7225, pop: 39964159 },
    { country: "South Africa", region: "Africa", year: 1997, lifeExp: 60.2, gdpPercap: 7479, pop: 42835005 },
    { country: "South Africa", region: "Africa", year: 2002, lifeExp: 53.4, gdpPercap: 7711, pop: 44433622 },
    { country: "South Africa", region: "Africa", year: 2007, lifeExp: 49.3, gdpPercap: 9270, pop: 43997828 },
    { country: "Argentina", region: "Americas", year: 1952, lifeExp: 62.5, gdpPercap: 5911, pop: 17876956 },
    { country: "Argentina", region: "Americas", year: 1957, lifeExp: 64.4, gdpPercap: 6857, pop: 19610538 },
    { country: "Argentina", region: "Americas", year: 1962, lifeExp: 65.1, gdpPercap: 7133, pop: 21283783 },
    { country: "Argentina", region: "Americas", year: 1967, lifeExp: 65.6, gdpPercap: 8053, pop: 22934225 },
    { country: "Argentina", region: "Americas", year: 1972, lifeExp: 67.1, gdpPercap: 9443, pop: 24779799 },
    { country: "Argentina", region: "Americas", year: 1977, lifeExp: 68.5, gdpPercap: 10079, pop: 26983828 },
    { country: "Argentina", region: "Americas", year: 1982, lifeExp: 69.9, gdpPercap: 8998, pop: 29341374 },
    { country: "Argentina", region: "Americas", year: 1987, lifeExp: 70.8, gdpPercap: 9140, pop: 31620918 },
    { country: "Argentina", region: "Americas", year: 1992, lifeExp: 71.9, gdpPercap: 9308, pop: 33958947 },
    { country: "Argentina", region: "Americas", year: 1997, lifeExp: 73.3, gdpPercap: 10967, pop: 36203463 },
    { country: "Argentina", region: "Americas", year: 2002, lifeExp: 74.3, gdpPercap: 8798, pop: 38331121 },
    { country: "Argentina", region: "Americas", year: 2007, lifeExp: 75.3, gdpPercap: 12779, pop: 40301927 },
    { country: "Brazil", region: "Americas", year: 1952, lifeExp: 50.9, gdpPercap: 2109, pop: 56602560 },
    { country: "Brazil", region: "Americas", year: 1957, lifeExp: 53.3, gdpPercap: 2487, pop: 65551171 },
    { country: "Brazil", region: "Americas", year: 1962, lifeExp: 55.7, gdpPercap: 3337, pop: 76039390 },
    { country: "Brazil", region: "Americas", year: 1967, lifeExp: 57.6, gdpPercap: 3430, pop: 88049823 },
    { country: "Brazil", region: "Americas", year: 1972, lifeExp: 59.5, gdpPercap: 4986, pop: 100840058 },
    { country: "Brazil", region: "Americas", year: 1977, lifeExp: 61.5, gdpPercap: 6660, pop: 114313951 },
    { country: "Brazil", region: "Americas", year: 1982, lifeExp: 63.3, gdpPercap: 7031, pop: 128962939 },
    { country: "Brazil", region: "Americas", year: 1987, lifeExp: 65.2, gdpPercap: 7807, pop: 142938076 },
    { country: "Brazil", region: "Americas", year: 1992, lifeExp: 67.1, gdpPercap: 6950, pop: 155975974 },
    { country: "Brazil", region: "Americas", year: 1997, lifeExp: 69.4, gdpPercap: 7958, pop: 168546719 },
    { country: "Brazil", region: "Americas", year: 2002, lifeExp: 71, gdpPercap: 8131, pop: 179914212 },
    { country: "Brazil", region: "Americas", year: 2007, lifeExp: 72.4, gdpPercap: 9066, pop: 190010647 },
    { country: "Canada", region: "Americas", year: 1952, lifeExp: 68.8, gdpPercap: 11367, pop: 14785584 },
    { country: "Canada", region: "Americas", year: 1957, lifeExp: 70, gdpPercap: 12490, pop: 17010154 },
    { country: "Canada", region: "Americas", year: 1962, lifeExp: 71.3, gdpPercap: 13462, pop: 18985849 },
    { country: "Canada", region: "Americas", year: 1967, lifeExp: 72.1, gdpPercap: 16077, pop: 20819767 },
    { country: "Canada", region: "Americas", year: 1972, lifeExp: 72.9, gdpPercap: 18971, pop: 22284500 },
    { country: "Canada", region: "Americas", year: 1977, lifeExp: 74.2, gdpPercap: 22091, pop: 23796400 },
    { country: "Canada", region: "Americas", year: 1982, lifeExp: 75.8, gdpPercap: 22899, pop: 25201900 },
    { country: "Canada", region: "Americas", year: 1987, lifeExp: 76.9, gdpPercap: 26627, pop: 26549700 },
    { country: "Canada", region: "Americas", year: 1992, lifeExp: 78, gdpPercap: 26343, pop: 28523502 },
    { country: "Canada", region: "Americas", year: 1997, lifeExp: 78.6, gdpPercap: 28955, pop: 30305843 },
    { country: "Canada", region: "Americas", year: 2002, lifeExp: 79.8, gdpPercap: 33329, pop: 31902268 },
    { country: "Canada", region: "Americas", year: 2007, lifeExp: 80.7, gdpPercap: 36319, pop: 33390141 },
    { country: "Chile", region: "Americas", year: 1952, lifeExp: 54.7, gdpPercap: 3940, pop: 6377619 },
    { country: "Chile", region: "Americas", year: 1957, lifeExp: 56.1, gdpPercap: 4316, pop: 7048426 },
    { country: "Chile", region: "Americas", year: 1962, lifeExp: 57.9, gdpPercap: 4519, pop: 7961258 },
    { country: "Chile", region: "Americas", year: 1967, lifeExp: 60.5, gdpPercap: 5107, pop: 8858908 },
    { country: "Chile", region: "Americas", year: 1972, lifeExp: 63.4, gdpPercap: 5494, pop: 9717524 },
    { country: "Chile", region: "Americas", year: 1977, lifeExp: 67.1, gdpPercap: 4757, pop: 10599793 },
    { country: "Chile", region: "Americas", year: 1982, lifeExp: 70.6, gdpPercap: 5096, pop: 11487112 },
    { country: "Chile", region: "Americas", year: 1987, lifeExp: 72.5, gdpPercap: 5547, pop: 12463354 },
    { country: "Chile", region: "Americas", year: 1992, lifeExp: 74.1, gdpPercap: 7596, pop: 13572994 },
    { country: "Chile", region: "Americas", year: 1997, lifeExp: 75.8, gdpPercap: 10118, pop: 14599929 },
    { country: "Chile", region: "Americas", year: 2002, lifeExp: 77.9, gdpPercap: 10779, pop: 15497046 },
    { country: "Chile", region: "Americas", year: 2007, lifeExp: 78.6, gdpPercap: 13172, pop: 16284741 },
    { country: "Mexico", region: "Americas", year: 1952, lifeExp: 50.8, gdpPercap: 3478, pop: 30144317 },
    { country: "Mexico", region: "Americas", year: 1957, lifeExp: 55.2, gdpPercap: 4132, pop: 35015548 },
    { country: "Mexico", region: "Americas", year: 1962, lifeExp: 58.3, gdpPercap: 4582, pop: 41121485 },
    { country: "Mexico", region: "Americas", year: 1967, lifeExp: 60.1, gdpPercap: 5755, pop: 47995559 },
    { country: "Mexico", region: "Americas", year: 1972, lifeExp: 62.4, gdpPercap: 6809, pop: 55984294 },
    { country: "Mexico", region: "Americas", year: 1977, lifeExp: 65, gdpPercap: 7675, pop: 63759976 },
    { country: "Mexico", region: "Americas", year: 1982, lifeExp: 67.4, gdpPercap: 9611, pop: 71640904 },
    { country: "Mexico", region: "Americas", year: 1987, lifeExp: 69.5, gdpPercap: 8688, pop: 80122492 },
    { country: "Mexico", region: "Americas", year: 1992, lifeExp: 71.5, gdpPercap: 9472, pop: 88111030 },
    { country: "Mexico", region: "Americas", year: 1997, lifeExp: 73.7, gdpPercap: 9767, pop: 95895146 },
    { country: "Mexico", region: "Americas", year: 2002, lifeExp: 74.9, gdpPercap: 10742, pop: 102479927 },
    { country: "Mexico", region: "Americas", year: 2007, lifeExp: 76.2, gdpPercap: 11978, pop: 108700891 },
    { country: "United States", region: "Americas", year: 1952, lifeExp: 68.4, gdpPercap: 13990, pop: 157553000 },
    { country: "United States", region: "Americas", year: 1957, lifeExp: 69.5, gdpPercap: 14847, pop: 171984000 },
    { country: "United States", region: "Americas", year: 1962, lifeExp: 70.2, gdpPercap: 16173, pop: 186538000 },
    { country: "United States", region: "Americas", year: 1967, lifeExp: 70.8, gdpPercap: 19530, pop: 198712000 },
    { country: "United States", region: "Americas", year: 1972, lifeExp: 71.3, gdpPercap: 21806, pop: 209896000 },
    { country: "United States", region: "Americas", year: 1977, lifeExp: 73.4, gdpPercap: 24073, pop: 220239000 },
    { country: "United States", region: "Americas", year: 1982, lifeExp: 74.7, gdpPercap: 25010, pop: 232187835 },
    { country: "United States", region: "Americas", year: 1987, lifeExp: 75, gdpPercap: 29884, pop: 242803533 },
    { country: "United States", region: "Americas", year: 1992, lifeExp: 76.1, gdpPercap: 32004, pop: 256894189 },
    { country: "United States", region: "Americas", year: 1997, lifeExp: 76.8, gdpPercap: 35767, pop: 272911760 },
    { country: "United States", region: "Americas", year: 2002, lifeExp: 77.3, gdpPercap: 39097, pop: 287675526 },
    { country: "United States", region: "Americas", year: 2007, lifeExp: 78.2, gdpPercap: 42952, pop: 301139947 },
    { country: "China", region: "Asia", year: 1952, lifeExp: 44, gdpPercap: 400, pop: 556263528 },
    { country: "China", region: "Asia", year: 1957, lifeExp: 50.5, gdpPercap: 576, pop: 637408000 },
    { country: "China", region: "Asia", year: 1962, lifeExp: 44.5, gdpPercap: 488, pop: 665770000 },
    { country: "China", region: "Asia", year: 1967, lifeExp: 58.4, gdpPercap: 613, pop: 754550000 },
    { country: "China", region: "Asia", year: 1972, lifeExp: 63.1, gdpPercap: 677, pop: 862030000 },
    { country: "China", region: "Asia", year: 1977, lifeExp: 64, gdpPercap: 741, pop: 943455000 },
    { country: "China", region: "Asia", year: 1982, lifeExp: 65.5, gdpPercap: 962, pop: 1000281000 },
    { country: "China", region: "Asia", year: 1987, lifeExp: 67.3, gdpPercap: 1379, pop: 1084035000 },
    { country: "China", region: "Asia", year: 1992, lifeExp: 68.7, gdpPercap: 1656, pop: 1164970000 },
    { country: "China", region: "Asia", year: 1997, lifeExp: 70.4, gdpPercap: 2289, pop: 1230075000 },
    { country: "China", region: "Asia", year: 2002, lifeExp: 72, gdpPercap: 3119, pop: 1280400000 },
    { country: "China", region: "Asia", year: 2007, lifeExp: 73, gdpPercap: 4959, pop: 1318683096 },
    { country: "India", region: "Asia", year: 1952, lifeExp: 37.4, gdpPercap: 547, pop: 372000000 },
    { country: "India", region: "Asia", year: 1957, lifeExp: 40.2, gdpPercap: 590, pop: 409000000 },
    { country: "India", region: "Asia", year: 1962, lifeExp: 43.6, gdpPercap: 658, pop: 454000000 },
    { country: "India", region: "Asia", year: 1967, lifeExp: 47.2, gdpPercap: 701, pop: 506000000 },
    { country: "India", region: "Asia", year: 1972, lifeExp: 50.7, gdpPercap: 724, pop: 567000000 },
    { country: "India", region: "Asia", year: 1977, lifeExp: 54.2, gdpPercap: 813, pop: 634000000 },
    { country: "India", region: "Asia", year: 1982, lifeExp: 56.6, gdpPercap: 856, pop: 708000000 },
    { country: "India", region: "Asia", year: 1987, lifeExp: 58.6, gdpPercap: 977, pop: 788000000 },
    { country: "India", region: "Asia", year: 1992, lifeExp: 60.2, gdpPercap: 1164, pop: 872000000 },
    { country: "India", region: "Asia", year: 1997, lifeExp: 61.8, gdpPercap: 1459, pop: 959000000 },
    { country: "India", region: "Asia", year: 2002, lifeExp: 62.9, gdpPercap: 1747, pop: 1034172547 },
    { country: "India", region: "Asia", year: 2007, lifeExp: 64.7, gdpPercap: 2452, pop: 1110396331 },
    { country: "Indonesia", region: "Asia", year: 1952, lifeExp: 37.5, gdpPercap: 750, pop: 82052000 },
    { country: "Indonesia", region: "Asia", year: 1957, lifeExp: 39.9, gdpPercap: 859, pop: 90124000 },
    { country: "Indonesia", region: "Asia", year: 1962, lifeExp: 42.5, gdpPercap: 849, pop: 99028000 },
    { country: "Indonesia", region: "Asia", year: 1967, lifeExp: 46, gdpPercap: 762, pop: 109343000 },
    { country: "Indonesia", region: "Asia", year: 1972, lifeExp: 49.2, gdpPercap: 1111, pop: 121282000 },
    { country: "Indonesia", region: "Asia", year: 1977, lifeExp: 52.7, gdpPercap: 1383, pop: 136725000 },
    { country: "Indonesia", region: "Asia", year: 1982, lifeExp: 56.2, gdpPercap: 1517, pop: 153343000 },
    { country: "Indonesia", region: "Asia", year: 1987, lifeExp: 60.1, gdpPercap: 1748, pop: 169276000 },
    { country: "Indonesia", region: "Asia", year: 1992, lifeExp: 62.7, gdpPercap: 2383, pop: 184816000 },
    { country: "Indonesia", region: "Asia", year: 1997, lifeExp: 66, gdpPercap: 3119, pop: 199278000 },
    { country: "Indonesia", region: "Asia", year: 2002, lifeExp: 68.6, gdpPercap: 2874, pop: 211060000 },
    { country: "Indonesia", region: "Asia", year: 2007, lifeExp: 70.7, gdpPercap: 3541, pop: 223547000 },
    { country: "Japan", region: "Asia", year: 1952, lifeExp: 63, gdpPercap: 3217, pop: 86459025 },
    { country: "Japan", region: "Asia", year: 1957, lifeExp: 65.5, gdpPercap: 4318, pop: 91563009 },
    { country: "Japan", region: "Asia", year: 1962, lifeExp: 68.7, gdpPercap: 6577, pop: 95831757 },
    { country: "Japan", region: "Asia", year: 1967, lifeExp: 71.4, gdpPercap: 9848, pop: 100825279 },
    { country: "Japan", region: "Asia", year: 1972, lifeExp: 73.4, gdpPercap: 14779, pop: 107188273 },
    { country: "Japan", region: "Asia", year: 1977, lifeExp: 75.4, gdpPercap: 16610, pop: 113872473 },
    { country: "Japan", region: "Asia", year: 1982, lifeExp: 77.1, gdpPercap: 19384, pop: 118454974 },
    { country: "Japan", region: "Asia", year: 1987, lifeExp: 78.7, gdpPercap: 22376, pop: 122091325 },
    { country: "Japan", region: "Asia", year: 1992, lifeExp: 79.4, gdpPercap: 26825, pop: 124329269 },
    { country: "Japan", region: "Asia", year: 1997, lifeExp: 80.7, gdpPercap: 28817, pop: 125956499 },
    { country: "Japan", region: "Asia", year: 2002, lifeExp: 82, gdpPercap: 28605, pop: 127065841 },
    { country: "Japan", region: "Asia", year: 2007, lifeExp: 82.6, gdpPercap: 31656, pop: 127467972 },
    { country: "South Korea", region: "Asia", year: 1952, lifeExp: 47.5, gdpPercap: 1031, pop: 20947571 },
    { country: "South Korea", region: "Asia", year: 1957, lifeExp: 52.7, gdpPercap: 1488, pop: 22611552 },
    { country: "South Korea", region: "Asia", year: 1962, lifeExp: 55.3, gdpPercap: 1536, pop: 26420307 },
    { country: "South Korea", region: "Asia", year: 1967, lifeExp: 57.7, gdpPercap: 2029, pop: 30131000 },
    { country: "South Korea", region: "Asia", year: 1972, lifeExp: 62.6, gdpPercap: 3031, pop: 33505000 },
    { country: "South Korea", region: "Asia", year: 1977, lifeExp: 64.8, gdpPercap: 4657, pop: 36436000 },
    { country: "South Korea", region: "Asia", year: 1982, lifeExp: 67.1, gdpPercap: 5623, pop: 39326000 },
    { country: "South Korea", region: "Asia", year: 1987, lifeExp: 69.8, gdpPercap: 8533, pop: 41622000 },
    { country: "South Korea", region: "Asia", year: 1992, lifeExp: 72.2, gdpPercap: 12104, pop: 43805450 },
    { country: "South Korea", region: "Asia", year: 1997, lifeExp: 74.6, gdpPercap: 15994, pop: 46173816 },
    { country: "South Korea", region: "Asia", year: 2002, lifeExp: 77, gdpPercap: 19234, pop: 47969150 },
    { country: "South Korea", region: "Asia", year: 2007, lifeExp: 78.6, gdpPercap: 23348, pop: 49044790 },
    { country: "Vietnam", region: "Asia", year: 1952, lifeExp: 40.4, gdpPercap: 605, pop: 26246839 },
    { country: "Vietnam", region: "Asia", year: 1957, lifeExp: 42.9, gdpPercap: 676, pop: 28998543 },
    { country: "Vietnam", region: "Asia", year: 1962, lifeExp: 45.4, gdpPercap: 772, pop: 33796140 },
    { country: "Vietnam", region: "Asia", year: 1967, lifeExp: 47.8, gdpPercap: 637, pop: 39463910 },
    { country: "Vietnam", region: "Asia", year: 1972, lifeExp: 50.3, gdpPercap: 700, pop: 44655014 },
    { country: "Vietnam", region: "Asia", year: 1977, lifeExp: 55.8, gdpPercap: 714, pop: 50533506 },
    { country: "Vietnam", region: "Asia", year: 1982, lifeExp: 58.8, gdpPercap: 707, pop: 56142181 },
    { country: "Vietnam", region: "Asia", year: 1987, lifeExp: 62.8, gdpPercap: 821, pop: 62826491 },
    { country: "Vietnam", region: "Asia", year: 1992, lifeExp: 67.7, gdpPercap: 989, pop: 69940728 },
    { country: "Vietnam", region: "Asia", year: 1997, lifeExp: 70.7, gdpPercap: 1386, pop: 76048996 },
    { country: "Vietnam", region: "Asia", year: 2002, lifeExp: 73, gdpPercap: 1764, pop: 80908147 },
    { country: "Vietnam", region: "Asia", year: 2007, lifeExp: 74.2, gdpPercap: 2442, pop: 85262356 },
    { country: "France", region: "Europe", year: 1952, lifeExp: 67.4, gdpPercap: 7030, pop: 42459667 },
    { country: "France", region: "Europe", year: 1957, lifeExp: 68.9, gdpPercap: 8663, pop: 44310863 },
    { country: "France", region: "Europe", year: 1962, lifeExp: 70.5, gdpPercap: 10560, pop: 47124000 },
    { country: "France", region: "Europe", year: 1967, lifeExp: 71.6, gdpPercap: 13000, pop: 49569000 },
    { country: "France", region: "Europe", year: 1972, lifeExp: 72.4, gdpPercap: 16107, pop: 51732000 },
    { country: "France", region: "Europe", year: 1977, lifeExp: 73.8, gdpPercap: 18293, pop: 53165019 },
    { country: "France", region: "Europe", year: 1982, lifeExp: 74.9, gdpPercap: 20294, pop: 54433565 },
    { country: "France", region: "Europe", year: 1987, lifeExp: 76.3, gdpPercap: 22066, pop: 55630100 },
    { country: "France", region: "Europe", year: 1992, lifeExp: 77.5, gdpPercap: 24704, pop: 57374179 },
    { country: "France", region: "Europe", year: 1997, lifeExp: 78.6, gdpPercap: 25890, pop: 58623428 },
    { country: "France", region: "Europe", year: 2002, lifeExp: 79.6, gdpPercap: 28926, pop: 59925035 },
    { country: "France", region: "Europe", year: 2007, lifeExp: 80.7, gdpPercap: 30470, pop: 61083916 },
    { country: "Germany", region: "Europe", year: 1952, lifeExp: 67.5, gdpPercap: 7144, pop: 69145952 },
    { country: "Germany", region: "Europe", year: 1957, lifeExp: 69.1, gdpPercap: 10188, pop: 71019069 },
    { country: "Germany", region: "Europe", year: 1962, lifeExp: 70.3, gdpPercap: 12902, pop: 73739117 },
    { country: "Germany", region: "Europe", year: 1967, lifeExp: 70.8, gdpPercap: 14746, pop: 76368453 },
    { country: "Germany", region: "Europe", year: 1972, lifeExp: 71, gdpPercap: 18016, pop: 78717088 },
    { country: "Germany", region: "Europe", year: 1977, lifeExp: 72.5, gdpPercap: 20513, pop: 78160773 },
    { country: "Germany", region: "Europe", year: 1982, lifeExp: 73.8, gdpPercap: 22032, pop: 78335266 },
    { country: "Germany", region: "Europe", year: 1987, lifeExp: 74.8, gdpPercap: 24639, pop: 77718298 },
    { country: "Germany", region: "Europe", year: 1992, lifeExp: 76.1, gdpPercap: 26505, pop: 80597764 },
    { country: "Germany", region: "Europe", year: 1997, lifeExp: 77.3, gdpPercap: 27789, pop: 82011073 },
    { country: "Germany", region: "Europe", year: 2002, lifeExp: 78.7, gdpPercap: 30036, pop: 82350671 },
    { country: "Germany", region: "Europe", year: 2007, lifeExp: 79.4, gdpPercap: 32170, pop: 82400996 },
    { country: "Italy", region: "Europe", year: 1952, lifeExp: 65.9, gdpPercap: 4931, pop: 47666000 },
    { country: "Italy", region: "Europe", year: 1957, lifeExp: 67.8, gdpPercap: 6249, pop: 49182000 },
    { country: "Italy", region: "Europe", year: 1962, lifeExp: 69.2, gdpPercap: 8244, pop: 50843200 },
    { country: "Italy", region: "Europe", year: 1967, lifeExp: 71.1, gdpPercap: 10022, pop: 52667100 },
    { country: "Italy", region: "Europe", year: 1972, lifeExp: 72.2, gdpPercap: 12269, pop: 54365564 },
    { country: "Italy", region: "Europe", year: 1977, lifeExp: 73.5, gdpPercap: 14256, pop: 56059245 },
    { country: "Italy", region: "Europe", year: 1982, lifeExp: 75, gdpPercap: 16537, pop: 56535636 },
    { country: "Italy", region: "Europe", year: 1987, lifeExp: 76.4, gdpPercap: 19207, pop: 56729703 },
    { country: "Italy", region: "Europe", year: 1992, lifeExp: 77.4, gdpPercap: 22014, pop: 56840847 },
    { country: "Italy", region: "Europe", year: 1997, lifeExp: 78.8, gdpPercap: 24675, pop: 57479469 },
    { country: "Italy", region: "Europe", year: 2002, lifeExp: 80.2, gdpPercap: 27968, pop: 57926999 },
    { country: "Italy", region: "Europe", year: 2007, lifeExp: 80.5, gdpPercap: 28570, pop: 58147733 },
    { country: "Poland", region: "Europe", year: 1952, lifeExp: 61.3, gdpPercap: 4029, pop: 25730551 },
    { country: "Poland", region: "Europe", year: 1957, lifeExp: 65.8, gdpPercap: 4734, pop: 28235346 },
    { country: "Poland", region: "Europe", year: 1962, lifeExp: 67.6, gdpPercap: 5339, pop: 30329617 },
    { country: "Poland", region: "Europe", year: 1967, lifeExp: 69.6, gdpPercap: 6557, pop: 31785378 },
    { country: "Poland", region: "Europe", year: 1972, lifeExp: 70.9, gdpPercap: 8007, pop: 33039545 },
    { country: "Poland", region: "Europe", year: 1977, lifeExp: 70.7, gdpPercap: 9508, pop: 34621254 },
    { country: "Poland", region: "Europe", year: 1982, lifeExp: 71.3, gdpPercap: 8452, pop: 36227381 },
    { country: "Poland", region: "Europe", year: 1987, lifeExp: 71, gdpPercap: 9082, pop: 37740710 },
    { country: "Poland", region: "Europe", year: 1992, lifeExp: 71, gdpPercap: 7739, pop: 38370697 },
    { country: "Poland", region: "Europe", year: 1997, lifeExp: 72.8, gdpPercap: 10160, pop: 38654957 },
    { country: "Poland", region: "Europe", year: 2002, lifeExp: 74.7, gdpPercap: 12002, pop: 38625976 },
    { country: "Poland", region: "Europe", year: 2007, lifeExp: 75.6, gdpPercap: 15390, pop: 38518241 },
    { country: "Spain", region: "Europe", year: 1952, lifeExp: 64.9, gdpPercap: 3834, pop: 28549870 },
    { country: "Spain", region: "Europe", year: 1957, lifeExp: 66.7, gdpPercap: 4565, pop: 29841614 },
    { country: "Spain", region: "Europe", year: 1962, lifeExp: 69.7, gdpPercap: 5694, pop: 31158061 },
    { country: "Spain", region: "Europe", year: 1967, lifeExp: 71.4, gdpPercap: 7994, pop: 32850275 },
    { country: "Spain", region: "Europe", year: 1972, lifeExp: 73.1, gdpPercap: 10639, pop: 34513161 },
    { country: "Spain", region: "Europe", year: 1977, lifeExp: 74.4, gdpPercap: 13237, pop: 36439000 },
    { country: "Spain", region: "Europe", year: 1982, lifeExp: 76.3, gdpPercap: 13926, pop: 37983310 },
    { country: "Spain", region: "Europe", year: 1987, lifeExp: 76.9, gdpPercap: 15765, pop: 38880702 },
    { country: "Spain", region: "Europe", year: 1992, lifeExp: 77.6, gdpPercap: 18603, pop: 39549438 },
    { country: "Spain", region: "Europe", year: 1997, lifeExp: 78.8, gdpPercap: 20445, pop: 39855442 },
    { country: "Spain", region: "Europe", year: 2002, lifeExp: 79.8, gdpPercap: 24835, pop: 40152517 },
    { country: "Spain", region: "Europe", year: 2007, lifeExp: 80.9, gdpPercap: 28821, pop: 40448191 },
    { country: "United Kingdom", region: "Europe", year: 1952, lifeExp: 69.2, gdpPercap: 9980, pop: 50430000 },
    { country: "United Kingdom", region: "Europe", year: 1957, lifeExp: 70.4, gdpPercap: 11283, pop: 51430000 },
    { country: "United Kingdom", region: "Europe", year: 1962, lifeExp: 70.8, gdpPercap: 12477, pop: 53292000 },
    { country: "United Kingdom", region: "Europe", year: 1967, lifeExp: 71.4, gdpPercap: 14143, pop: 54959000 },
    { country: "United Kingdom", region: "Europe", year: 1972, lifeExp: 72, gdpPercap: 15895, pop: 56079000 },
    { country: "United Kingdom", region: "Europe", year: 1977, lifeExp: 72.8, gdpPercap: 17429, pop: 56179000 },
    { country: "United Kingdom", region: "Europe", year: 1982, lifeExp: 74, gdpPercap: 18232, pop: 56339704 },
    { country: "United Kingdom", region: "Europe", year: 1987, lifeExp: 75, gdpPercap: 21665, pop: 56981620 },
    { country: "United Kingdom", region: "Europe", year: 1992, lifeExp: 76.4, gdpPercap: 22705, pop: 57866349 },
    { country: "United Kingdom", region: "Europe", year: 1997, lifeExp: 77.2, gdpPercap: 26075, pop: 58808266 },
    { country: "United Kingdom", region: "Europe", year: 2002, lifeExp: 78.5, gdpPercap: 29479, pop: 59912431 },
    { country: "United Kingdom", region: "Europe", year: 2007, lifeExp: 79.4, gdpPercap: 33203, pop: 60776238 },
    { country: "Australia", region: "Oceania", year: 1952, lifeExp: 69.1, gdpPercap: 10040, pop: 8691212 },
    { country: "Australia", region: "Oceania", year: 1957, lifeExp: 70.3, gdpPercap: 10950, pop: 9712569 },
    { country: "Australia", region: "Oceania", year: 1962, lifeExp: 70.9, gdpPercap: 12217, pop: 10794968 },
    { country: "Australia", region: "Oceania", year: 1967, lifeExp: 71.1, gdpPercap: 14526, pop: 11872264 },
    { country: "Australia", region: "Oceania", year: 1972, lifeExp: 71.9, gdpPercap: 16789, pop: 13177000 },
    { country: "Australia", region: "Oceania", year: 1977, lifeExp: 73.5, gdpPercap: 18334, pop: 14074100 },
    { country: "Australia", region: "Oceania", year: 1982, lifeExp: 74.7, gdpPercap: 19477, pop: 15184200 },
    { country: "Australia", region: "Oceania", year: 1987, lifeExp: 76.3, gdpPercap: 21889, pop: 16257249 },
    { country: "Australia", region: "Oceania", year: 1992, lifeExp: 77.6, gdpPercap: 23425, pop: 17481977 },
    { country: "Australia", region: "Oceania", year: 1997, lifeExp: 78.8, gdpPercap: 26998, pop: 18565243 },
    { country: "Australia", region: "Oceania", year: 2002, lifeExp: 80.4, gdpPercap: 30688, pop: 19546792 },
    { country: "Australia", region: "Oceania", year: 2007, lifeExp: 81.2, gdpPercap: 34435, pop: 20434176 },
    { country: "New Zealand", region: "Oceania", year: 1952, lifeExp: 69.4, gdpPercap: 10557, pop: 1994794 },
    { country: "New Zealand", region: "Oceania", year: 1957, lifeExp: 70.3, gdpPercap: 12247, pop: 2229407 },
    { country: "New Zealand", region: "Oceania", year: 1962, lifeExp: 71.2, gdpPercap: 13176, pop: 2488550 },
    { country: "New Zealand", region: "Oceania", year: 1967, lifeExp: 71.5, gdpPercap: 14464, pop: 2728150 },
    { country: "New Zealand", region: "Oceania", year: 1972, lifeExp: 71.9, gdpPercap: 16046, pop: 2929100 },
    { country: "New Zealand", region: "Oceania", year: 1977, lifeExp: 72.2, gdpPercap: 16234, pop: 3164900 },
    { country: "New Zealand", region: "Oceania", year: 1982, lifeExp: 73.8, gdpPercap: 17632, pop: 3210650 },
    { country: "New Zealand", region: "Oceania", year: 1987, lifeExp: 74.3, gdpPercap: 19007, pop: 3317166 },
    { country: "New Zealand", region: "Oceania", year: 1992, lifeExp: 76.3, gdpPercap: 18363, pop: 3437674 },
    { country: "New Zealand", region: "Oceania", year: 1997, lifeExp: 77.6, gdpPercap: 21050, pop: 3676187 },
    { country: "New Zealand", region: "Oceania", year: 2002, lifeExp: 79.1, gdpPercap: 23190, pop: 3908037 },
    { country: "New Zealand", region: "Oceania", year: 2007, lifeExp: 80.2, gdpPercap: 25185, pop: 4115771 },
];

/** The five regions, in a stable display order. */
export const REGIONS = ["Africa", "Americas", "Asia", "Europe", "Oceania"] as const;

/** Distinct years present in {@link DEV_DATA}, ascending. */
export const YEARS: readonly number[] = [
    ...new Set(DEV_DATA.map((row) => row.year)),
].sort((a, b) => a - b);

/** Earliest year in the dataset. */
export const EARLIEST_YEAR = YEARS[0];
/** Most recent year in the dataset — the default snapshot year. */
export const LATEST_YEAR = YEARS[YEARS.length - 1];

/** How many countries the "most populous" ranking shows. */
export const topCountriesLimit = 12;

/** Region slicer options (multi-select). */
export const regionOptions: readonly SlicerOption[] = REGIONS.map((region) => ({
    value: region,
    label: region,
}));

/** Year slicer options (single-select), most recent first. */
export const yearOptions: readonly SlicerOption[] = [...YEARS]
    .sort((a, b) => b - a)
    .map((year) => ({ value: year, label: String(year) }));

/* --------------------------- Aggregation helpers ---------------------------- *
 * Pure, dependency-free reshapes over already-filtered rows. The dashboard memoizes
 * their results so charts keep a stable data identity across re-renders.
 * --------------------------------------------------------------------------- */

/** A region's indicators aggregated for one year (population-weighted). */
export type RegionYearPoint = {
    region: string;
    year: number;
    lifeExp: number;
    gdpPercap: number;
    pop: number;
}

/** Global (all-region) indicators aggregated for one year. */
export type GlobalYearPoint = {
    year: number;
    lifeExp: number;
    gdpPercap: number;
    pop: number;
    countries: number;
}

/** Population-weighted mean of a per-capita metric across rows. */
function weightedMean(rows: readonly DevRow[], key: "lifeExp" | "gdpPercap"): number {
    let weighted = 0;
    let population = 0;
    for (const row of rows) {
        weighted += row[key] * row.pop;
        population += row.pop;
    }
    return population === 0 ? 0 : weighted / population;
}

/** Rows for a single year. */
export function snapshot(rows: readonly DevRow[], year: number): DevRow[] {
    return rows.filter((row) => row.year === year);
}

/**
 * Collapse rows to one point per year (all regions), with population-weighted
 * life expectancy / GDP per capita and total population — for KPI trends.
 */
export function byYear(rows: readonly DevRow[]): GlobalYearPoint[] {
    const groups = new Map<number, DevRow[]>();
    for (const row of rows) {
        const bucket = groups.get(row.year);
        if (bucket) bucket.push(row);
        else groups.set(row.year, [row]);
    }
    return [...groups.entries()]
        .map(([year, group]) => ({
            year,
            lifeExp: weightedMean(group, "lifeExp"),
            gdpPercap: weightedMean(group, "gdpPercap"),
            pop: group.reduce((sum, row) => sum + row.pop, 0),
            countries: new Set(group.map((row) => row.country)).size,
        }))
        .sort((a, b) => a.year - b.year);
}

/**
 * Collapse rows to one point per region × year (population-weighted metrics) —
 * for the multi-series regional trend.
 */
export function byRegionYear(rows: readonly DevRow[]): RegionYearPoint[] {
    const groups = new Map<string, DevRow[]>();
    for (const row of rows) {
        const key = `${row.region}__${row.year}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
    }
    const regionRank = new Map<string, number>(
        REGIONS.map((region, index) => [region, index]),
    );
    return [...groups.values()]
        .map((group) => ({
            region: group[0].region,
            year: group[0].year,
            lifeExp: weightedMean(group, "lifeExp"),
            gdpPercap: weightedMean(group, "gdpPercap"),
            pop: group.reduce((sum, row) => sum + row.pop, 0),
        }))
        .sort(
            (a, b) =>
                (regionRank.get(a.region) ?? 0) - (regionRank.get(b.region) ?? 0) ||
                a.year - b.year,
        );
}

/** Total population per region for the given rows (pass a single-year snapshot). */
export function popShareByRegion(rows: readonly DevRow[]): Array<{ region: string; pop: number }> {
    const totals = new Map<string, number>();
    for (const row of rows) {
        totals.set(row.region, (totals.get(row.region) ?? 0) + row.pop);
    }
    const regionRank = new Map<string, number>(
        REGIONS.map((region, index) => [region, index]),
    );
    return [...totals.entries()]
        .map(([region, pop]) => ({ region, pop }))
        .sort((a, b) => (regionRank.get(a.region) ?? 0) - (regionRank.get(b.region) ?? 0));
}
