import type {
    BaseItemDto,
    MediaSourceInfo,
    PlayMethod
} from '@jellyfin/sdk/lib/generated-client';

import {
    getNextPlaybackItemInfo,
    broadcastConnectionErrorMessage,
    createStreamInfo
} from '../helpers';

import {
    getPlaybackInfo,
    getLiveStream,
    load,
    stop,
    stopPingInterval
} from './jellyfinActions';
import { getDeviceProfile } from './deviceprofileBuilder';

import {
    onStopPlayerBeforePlaybackDone,
    getMaxBitrate,
    getOptimalMediaSource,
    showPlaybackInfoErrorMessage,
    checkDirectPlay,
    createMediaInformation
} from './maincontroller';

import { DocumentManager } from './documentManager';

export interface PlaybackState {
    startPositionTicks: number;
    mediaType: string | null | undefined;
    itemId: string;

    audioStreamIndex: null;
    subtitleStreamIndex: number | null;
    mediaSource: MediaSourceInfo | null;
    mediaSourceId: string;
    PlaybackMediaSource: MediaSourceInfo | null;

    playMethod: PlayMethod | undefined;
    canSeek: boolean;
    isChangingStream: boolean;
    playNextItemBool: boolean;

    item: BaseItemDto | null;
    liveStreamId: string;
    playSessionId: string;

    runtimeTicks: number;
}

export class playbackManager {
    private playerManager: framework.PlayerManager;
    // TODO remove any
    private activePlaylist: Array<BaseItemDto>;
    private activePlaylistIndex: number;

    playbackState: PlaybackState = {
        audioStreamIndex: null,
        canSeek: false,
        isChangingStream: false,
        item: null,
        itemId: '',
        liveStreamId: '',
        mediaSource: null,
        mediaSourceId: '',
        mediaType: '',
        PlaybackMediaSource: null,
        playMethod: undefined,
        playNextItemBool: true,
        playSessionId: '',
        runtimeTicks: 0,
        startPositionTicks: 0,
        subtitleStreamIndex: null
    };

    constructor(playerManager: framework.PlayerManager) {
        // Parameters
        this.playerManager = playerManager;

        // Properties
        this.activePlaylist = [];
        this.activePlaylistIndex = 0;
    }

    /* This is used to check if we can switch to
     * some other info overlay.
     *
     * Returns true when playing or paused.
     * (before: true only when playing)
     * */
    isPlaying(): boolean {
        return (
            this.playerManager.getPlayerState() ===
                cast.framework.messages.PlayerState.PLAYING ||
            this.playerManager.getPlayerState() ===
                cast.framework.messages.PlayerState.PAUSED
        );
    }

    async playFromOptions(options: any): Promise<boolean> {
        const firstItem = options.items[0];

        if (options.startPositionTicks || firstItem.MediaType !== 'Video') {
            return this.playFromOptionsInternal(options);
        }

        return this.playFromOptionsInternal(options);
    }

    playFromOptionsInternal(options: any): boolean {
        const stopPlayer =
            this.activePlaylist && this.activePlaylist.length > 0;

        this.activePlaylist = options.items;
        window.currentPlaylistIndex = -1;
        window.playlist = this.activePlaylist;

        return this.playNextItem(options, stopPlayer);
    }

    playNextItem(options: any = {}, stopPlayer = false): boolean {
        const nextItemInfo = getNextPlaybackItemInfo();

        if (nextItemInfo) {
            this.activePlaylistIndex = nextItemInfo.index;

            const item = nextItemInfo.item;

            this.playItem(item, options, stopPlayer);

            return true;
        }

        return false;
    }

    playPreviousItem(options: any = {}): boolean {
        if (this.activePlaylist && this.activePlaylistIndex > 0) {
            this.activePlaylistIndex--;

            const item = this.activePlaylist[this.activePlaylistIndex];

            this.playItem(item, options, true);

            return true;
        }

        return false;
    }

    async playItem(
        item: BaseItemDto,
        options: any,
        stopPlayer = false
    ): Promise<void> {
        if (stopPlayer) {
            await this.stop(true);
        }

        return await onStopPlayerBeforePlaybackDone(item, options);
    }

    async playItemInternal(item: BaseItemDto, options: any): Promise<void> {
        this.playbackState.isChangingStream = false;
        DocumentManager.setAppStatus('loading');

        const maxBitrate = await getMaxBitrate();
        const deviceProfile = getDeviceProfile({
            bitrateSetting: maxBitrate,
            enableHls: true
        });
        const playbackInfo = await getPlaybackInfo(
            item,
            maxBitrate,
            deviceProfile,
            options.startPositionTicks,
            options.mediaSourceId,
            options.audioStreamIndex,
            options.subtitleStreamIndex
        ).catch(broadcastConnectionErrorMessage);

        if (playbackInfo.ErrorCode) {
            return showPlaybackInfoErrorMessage(playbackInfo.ErrorCode);
        }

        const mediaSource = await getOptimalMediaSource(
            playbackInfo.MediaSources
        );

        if (!mediaSource) {
            return showPlaybackInfoErrorMessage('NoCompatibleStream');
        }

        let itemToPlay = mediaSource;

        if (mediaSource.RequiresOpening) {
            const openLiveStreamResult = await getLiveStream(
                item,
                playbackInfo.PlaySessionId,
                maxBitrate,
                deviceProfile,
                options.startPositionTicks,
                mediaSource,
                null,
                null
            );

            if (openLiveStreamResult.MediaSource) {
                checkDirectPlay(openLiveStreamResult.MediaSource);
                itemToPlay = openLiveStreamResult.MediaSource;
            }
        }

        this.playMediaSource(
            playbackInfo.PlaySessionId,
            item,
            itemToPlay,
            options
        );
    }

    // TODO eradicate any
    playMediaSource(
        playSessionId: string,
        item: BaseItemDto,
        mediaSource: MediaSourceInfo,
        options: any
    ): void {
        DocumentManager.setAppStatus('loading');

        const streamInfo = createStreamInfo(
            item,
            mediaSource,
            options.startPositionTicks
        );

        const url = streamInfo.url;

        const mediaInfo = createMediaInformation(
            playSessionId,
            item,
            streamInfo
        );
        const loadRequestData = new cast.framework.messages.LoadRequestData();

        loadRequestData.media = mediaInfo;
        loadRequestData.autoplay = true;

        // If we should seek at the start, translate it
        // to seconds and give it to loadRequestData :)
        if (mediaInfo.customData.startPositionTicks > 0) {
            loadRequestData.currentTime =
                mediaInfo.customData.startPositionTicks / 10000000;
        }

        load(this, mediaInfo.customData, item);
        this.playerManager.load(loadRequestData);

        this.playbackState.PlaybackMediaSource = mediaSource;

        console.log(`setting src to ${url}`);
        this.playbackState.mediaSource = mediaSource;

        DocumentManager.setPlayerBackdrop(item);

        // We use false as we do not want to broadcast the new status yet
        // we will broadcast manually when the media has been loaded, this
        // is to be sure the duration has been updated in the media element
        this.playerManager.setMediaInformation(mediaInfo, false);
    }

    stop(continuing = false): void {
        this.playbackState.playNextItemBool = continuing;
        stop();

        stopPingInterval();

        this.playerManager.stop();

        this.activePlaylist = [];
        this.activePlaylistIndex = -1;
        DocumentManager.startBackdropInterval();
    }

    /**
     * Attempt to clean the receiver state.
     */
    resetPlaybackScope(): void {
        DocumentManager.setAppStatus('waiting');

        this.playbackState.startPositionTicks = 0;
        DocumentManager.setWaitingBackdrop(null, null);
        this.playbackState.mediaType = '';
        this.playbackState.itemId = '';

        this.playbackState.audioStreamIndex = null;
        this.playbackState.subtitleStreamIndex = null;
        this.playbackState.mediaSource = null;
        this.playbackState.mediaSourceId = '';
        this.playbackState.PlaybackMediaSource = null;

        this.playbackState.playMethod = undefined;
        this.playbackState.canSeek = false;
        this.playbackState.isChangingStream = false;
        this.playbackState.playNextItemBool = true;

        this.playbackState.item = null;
        this.playbackState.liveStreamId = '';
        this.playbackState.playSessionId = '';

        // Detail content
        DocumentManager.setLogo(null);
        DocumentManager.setDetailImage(null);
    }
}
