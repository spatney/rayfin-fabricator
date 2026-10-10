import { Config } from '@remotion/cli/config';
import { webpackOverride } from './webpack-override.mjs';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setColorSpace('bt709');
Config.setCrf(25);
Config.setX264Preset('slow');
Config.setAudioBitrate('160k');
// The CLI runs from this folder (npm scripts), so the working directory is the project root.
Config.overrideWebpackConfig(webpackOverride(process.cwd()));
