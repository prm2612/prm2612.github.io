'use strict';

const NAMESPACE = 'urn:x-cast:com.google.ads.ima.cast';

class Player {
  constructor(mediaElement) {

    this.backupStream_ = 'http://storage.googleapis.com/testtopbox-public/video_content/bbb/master.m3u8';

    this.startTime_ = 0;

    this.castContext_ = cast.framework.CastReceiverContext.getInstance();

    this.playerManager_ = this.castContext_.getPlayerManager();

    this.mediaElement_ = mediaElement.getMediaElement();

    // Map of namespace names to their types.
    const options = new cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[NAMESPACE] =
      cast.framework.system.MessageType.STRING;

    this.castContext_.start(options);

    this.streamManager_ =
      new google.ima.dai.api.StreamManager(this.mediaElement_);

    this.setupCallbacks();
  }

  setupCallbacks() {
    
    /*
    // Chromecast device is disconnected from sender app.
    this.castContext_.addEventListener(
      cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
        window.close();
      });
    */

    // Receives messages from sender app. The message is a comma separated string
    // where the first substring indicates the function to be called and the
    // following substrings are the parameters to be passed to the function.
    this.castContext_.addCustomMessageListener(NAMESPACE, (event) => {
      console.log('Received message from sender: ' + event.data);
      const message = event.data.split(',');
      const method = message[0];
      switch (method) {
        case 'bookmark':
          const time = parseFloat(message[1]);
          const bookmarkTime = this.streamManager_.contentTimeForStreamTime(time);
          this.broadcast('bookmark,' + bookmarkTime);
          this.bookmark(time);
          break;
        case 'getContentTime':
          const contentTime = this.getContentTime();
          this.broadcast('contentTime,' + contentTime);
          break;
        default:
          this.broadcast('Message not recognized');
          break;
      }
    });

    this.playerManager_.setMessageInterceptor(
      cast.framework.messages.MessageType.LOAD, (request) => {

        return new Promise((resolve, reject) => {

          //Set media info and resolve promise on successful stream request
          this.streamManager_.addEventListener(google.ima.dai.api.StreamEvent.Type.LOADED, (event) => {
            this.broadcast('Stream request successful. Loading stream...')
            request.media.contentUrl = event.getStreamData().url;
            request.media.subtitles = event.getStreamData().subtitles;
            resolve(request);
          }, false)

          //Prepare backup stream and resolve promise on stream request error
          this.streamManager_.addEventListener(google.ima.dai.api.StreamEvent.Type.ERROR, (event) => {
            this.broadcast('Stream request failed. Loading backup stream...')
            request.media.contentUrl = this.backupStream_;
            resolve(request);
          }, false)

          var fireManualTimeUpdate = false;
          if(request.media.streamType === cast.framework.messages.StreamType.BUFFERED) {
            fireManualTimeUpdate = request.currentTime === 0;
          }
          console.log("Will we fire manual time update: " + fireManualTimeUpdate);

          //Request Stream
          const imaRequestData = request.media.customData;
          this.requestStream(imaRequestData, fireManualTimeUpdate);

          //For VOD Streams, update start time on media element
          if (this.startTime_ && request.media.streamType === cast.framework.messages.StreamType.BUFFERED) {
            this.mediaElement_.currentTime = this.streamManager_.streamTimeForContentTime(this.startTime_);
          }
          
        });
      }
    );

    this.playerManager_.setMessageInterceptor(
      cast.framework.messages.MessageType.SEEK, (seekRequest) => {
        const seekTo = seekRequest.currentTime;
        const previousCuepoint = this.streamManager_.previousCuePointForStreamTime(seekTo);
        if (this.adIsPlaying_) {
          seekRequest.currentTime = this.mediaElement_.currentTime;
        } else if (!previousCuepoint.played) {
          // Adding 0.1 to cuepoint start time because of bug where stream freezes
          // when seeking to certain times in VOD streams.
          seekRequest.currentTime = previousCuepoint.start + 0.1
          this.seekToTimeAfterAdBreak_ = seekTo;
        }
        return seekRequest;
      }
    );

    this.playerManager_.addEventListener(cast.framework.events.EventType.ID3, (event) => {
      this.streamManager_.processMetadata('ID3', event.segmentData, event.timestamp)
    });

    this.streamManager_.addEventListener(google.ima.dai.api.StreamEvent.Type.AD_BREAK_STARTED, (event) => {
      this.adIsPlaying_ = true;
      document.getElementById('ad-ui').style.display = 'block';
      this.broadcast('adBreakStarted');
    });

    this.streamManager_.addEventListener(google.ima.dai.api.StreamEvent.Type.AD_BREAK_ENDED, (event) => {
      this.adIsPlaying_ = false;
      document.getElementById('ad-ui').style.display = 'none';
      this.broadcast('adBreakEnded');
      if (this.seekToTimeAfterAdBreak_) {
        this.seek(this.seekToTimeAfterAdBreak_);
        this.seekToTimeAfterAdBreak_ = 0;
      }
    });
    
    this.streamManager_.addEventListener(google.ima.dai.api.StreamEvent.Type.AD_PROGRESS, (event) => {
      const adData = event.getStreamData().adProgressData;
      document.getElementById('ad-position').innerHTML = adData.adPosition;
      document.getElementById('total-ads').innerHTML = adData.totalAds;
      document.getElementById('time-value').innerHTML = Math.ceil(parseFloat(adData.duration) - parseFloat(adData.currentTime));
      document.getElementById('ad-ui').style.display = 'block';
    });

    //Log the quartile events to the console for debugging
    const quartileEvents = [google.ima.dai.api.StreamEvent.Type.STARTED,
      google.ima.dai.api.StreamEvent.Type.FIRST_QUARTILE,
      google.ima.dai.api.StreamEvent.Type.MIDPOINT,
      google.ima.dai.api.StreamEvent.Type.THIRD_QUARTILE,
      google.ima.dai.api.StreamEvent.Type.COMPLETE];
    this.streamManager_.addEventListener(quartileEvents, (event) => {
      console.log(`IMA SDK Event: ${event.type}`);
    }, false);

  }

  requestStream(request, fireManualTimeUpdate) {
    this.startTime_ = request.startTime;
    console.log("fire manual time update: " + fireManualTimeUpdate);
    const streamRequest = (request.assetKey) ?
      new google.ima.dai.api.LiveStreamRequest(request) :
      new google.ima.dai.api.VODStreamRequest(request).then(() => {
        if (fireManualTimeUpdate) {
          console.log("firing manual time update");
          mediaElement_.dispatchEvent(new Event('timeupdate'));
        }
      });
    this.streamManager_.requestStream(streamRequest);
    document.getElementById('splash').style.display = 'none';
  }

  seek(time) {
    if (!this.adIsPlaying_) {
      this.mediaElement_.currentTime = time;
      this.broadcast('Seeking to: ' + time);
    }
  }

  getContentTime() {
    const currentTime = this.mediaElement_.currentTime;
    return this.streamManager_.contentTimeForStreamTime(currentTime);
  }

  broadcast(message) {
    console.log(message);
    this.castContext_.sendCustomMessage(NAMESPACE, undefined, message);
  }
} 
