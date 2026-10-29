import React, { useState } from 'react';
import {
  X,
  Play,
  Camera,
  Mic,
  Monitor,
  Smartphone,
  ShieldAlert,
  Sliders,
} from 'lucide-react';
import { Device, Session } from '../types';
import { createRemoteSession, recordSecurityAudit } from '../services/signaling';
import { updateDeviceHeartbeat } from '../services/deviceService';

interface StartSessionModalProps {
  device: Device;
  adminId: string;
  isOpen: boolean;
  onClose: () => void;
  onSessionStarted: (session: Session) => void;
}

export const StartSessionModal: React.FC<StartSessionModalProps> = ({
  device,
  adminId,
  isOpen,
  onClose,
  onSessionStarted,
}) => {
  const [requestCamera, setRequestCamera] = useState<boolean>(true);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment');
  const [requestMicrophone, setRequestMicrophone] = useState<boolean>(true);
  const [requestScreen, setRequestScreen] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleStart = async () => {
    setIsSubmitting(true);
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      await createRemoteSession({
        sessionId,
        adminId,
        deviceId: device.deviceId,
        requestCamera,
        cameraFacing,
        requestMicrophone,
        requestScreen,
      });

      // Update currentSessionId on the device document so the secondary phone receives it via single-doc listener
      await updateDeviceHeartbeat(device.deviceId, { currentSessionId: sessionId });

      await recordSecurityAudit({
        adminId,
        deviceId: device.deviceId,
        eventType: 'SESSION_REQUESTED',
        details: `Requested remote session for ${device.deviceName} (Camera: ${requestCamera ? cameraFacing : 'off'}, Mic: ${requestMicrophone}, Screen: ${requestScreen})`,
      });

      const newSession: Session = {
        sessionId,
        adminId,
        deviceId: device.deviceId,
        status: 'requested',
        requestCamera,
        cameraFacing,
        requestMicrophone,
        requestScreen,
        startedAt: Date.now(),
      };

      onSessionStarted(newSession);
      onClose();
    } catch (err) {
      console.error('Failed to create remote session:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Start Support Session</h3>
              <p className="text-xs text-slate-400">{device.deviceName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <p className="text-xs text-slate-300">
            Select which media streams to request from this Android phone. The user will receive an authenticated confirmation prompt before capture begins.
          </p>

          {/* Camera Option */}
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <Camera className="w-4 h-4 text-indigo-400" />
                <div>
                  <span className="text-xs font-semibold text-white block">Camera Stream</span>
                  <span className="text-[11px] text-slate-400">Live video from device camera</span>
                </div>
              </div>
              <input
                type="checkbox"
                checked={requestCamera}
                onChange={(e) => setRequestCamera(e.target.checked)}
                className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
              />
            </div>

            {requestCamera && (
              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">Initial Camera Lens</span>
                <div className="flex space-x-1.5">
                  <button
                    type="button"
                    onClick={() => setCameraFacing('environment')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition ${
                      cameraFacing === 'environment'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    Rear (Default)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCameraFacing('user')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition ${
                      cameraFacing === 'user'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    Front
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Microphone Option */}
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <Mic className="w-4 h-4 text-indigo-400" />
              <div>
                <span className="text-xs font-semibold text-white block">Microphone Audio</span>
                <span className="text-[11px] text-slate-400">Live two-way / input audio feed</span>
              </div>
            </div>
            <input
              type="checkbox"
              checked={requestMicrophone}
              onChange={(e) => setRequestMicrophone(e.target.checked)}
              className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
            />
          </div>

          {/* Screen Share Option */}
          <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <Monitor className="w-4 h-4 text-indigo-400" />
              <div>
                <span className="text-xs font-semibold text-white block">Screen Sharing</span>
                <span className="text-[11px] text-slate-400">Request phone screen / app capture</span>
              </div>
            </div>
            <input
              type="checkbox"
              checked={requestScreen}
              onChange={(e) => setRequestScreen(e.target.checked)}
              className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
            />
          </div>

          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-start space-x-2 text-indigo-300 text-xs">
            <ShieldAlert className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <span>
              Real WebRTC connection will be established. Only the administrator can issue an administrative disconnect.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end space-x-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={isSubmitting || (!requestCamera && !requestMicrophone && !requestScreen)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 shadow-lg shadow-indigo-600/20 transition"
          >
            {isSubmitting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Play className="w-4 h-4" />
                <span>Request Session</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
