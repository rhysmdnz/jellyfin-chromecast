import {
    getNextPlaybackItemInfo,
    broadcastConnectionErrorMessage,
    createStreamInfo
} from '../helpers';

import {
    getPlaybackInfo,
    getLiveStream,
    load,
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
import { BaseItemDto } from '~/api/generated/models/base-item-dto';
import { MediaSourceInfo } from '~/api/generated/models/media-source-info';

export class playbackManager {
    private playerManager: framework.PlayerManager;
    // TODO remove any
    private activePlaylist: Array<BaseItemDto>;
    private activePlaylistIndex: number;

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
            this.stop();
        }

        return await onStopPlayerBeforePlaybackDone(item, options);
    }

    async playItemInternal(item: BaseItemDto, options: any): Promise<void> {
        $scope.isChangingStream = false;
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
            options.subtitleStreamIndex,
            options.liveStreamId
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

        load($scope, mediaInfo.customData, item);
        this.playerManager.load(loadRequestData);

        console.log(`setting src to ${streamInfo.url}`);
        $scope.PlaybackMediaSource = mediaSource;

        $scope.mediaSource = mediaSource;
        $scope.audioStreamIndex = streamInfo.audioStreamIndex;
        $scope.subtitleStreamIndex = streamInfo.subtitleStreamIndex;

        DocumentManager.setPlayerBackdrop(item);

        // We use false as we do not want to broadcast the new status yet
        // we will broadcast manually when the media has been loaded, this
        // is to be sure the duration has been updated in the media element
        this.playerManager.setMediaInformation(mediaInfo, false);
    }

    /**
     * stop playback, as requested by the client
     */
    stop(): void {
        this.playerManager.stop();
        // onStopped will be called when playback comes to a halt.
    }

    /**
     * Called when media stops playing.
     * TODO avoid doing this between tracks in a playlist
     *
     * @param _continue - If we have another item coming up in the playlist. Only used for notifying the cast sender.
     */
    onStopped(_continue: boolean): void {
        $scope.playNextItem = _continue;

        DocumentManager.setAppStatus('waiting');

        stopPingInterval();

        this.activePlaylist = [];
        this.activePlaylistIndex = -1;
        DocumentManager.startBackdropInterval();
    }
}
