import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  APIProvider,
  Map as GoogleMap,
  AdvancedMarker,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  MapPin,
  Crosshair,
  ExternalLink,
  RefreshCw,
  Smartphone,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  AlertCircle,
  LocateFixed,
  Eye,
  Compass,
  Navigation,
} from 'lucide-react';
import { Device, DeviceLocation } from '../types';

interface DeviceMapViewerProps {
  devices: Device[];
  selectedDeviceId?: string | null;
  onSelectDevice?: (device: Device) => void;
  onRequestLocationPing?: (deviceId: string) => Promise<void>;
  compact?: boolean;
  className?: string;
}

interface MapControllerProps {
  devicesWithLocation: Device[];
  activeDevice: Device | null;
  followActive: boolean;
  onUserDragStart: () => void;
  recenterSignal: number;
  zoomDeltaSignal: { seq: number; delta: number };
  streetViewSignal: number;
  localFocusTarget: { lat: number; lng: number; seq: number } | null;
  onStreetViewStatus: (active: boolean, notice?: string) => void;
}

const MapController: React.FC<MapControllerProps> = ({
  devicesWithLocation,
  activeDevice,
  followActive,
  onUserDragStart,
  recenterSignal,
  zoomDeltaSignal,
  streetViewSignal,
  localFocusTarget,
  onStreetViewStatus,
}) => {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const streetViewLib = useMapsLibrary('streetView');
  const circlesRef = useRef<Record<string, any>>({});
  const lastPannedCoordsRef = useRef<string>('');
  const lastRecenterSeqRef = useRef<number>(0);
  const lastZoomSeqRef = useRef<number>(0);
  const lastStreetViewSeqRef = useRef<number>(0);
  const lastLocalFocusSeqRef = useRef<number>(0);

  // Pause auto-follow as soon as the user manually pans or moves the map
  useEffect(() => {
    if (!map) return;
    const listener = map.addListener('dragstart', () => {
      onUserDragStart();
    });
    return () => listener.remove();
  }, [map, onUserDragStart]);

  // Listen to Street View visibility changes
  useEffect(() => {
    if (!map) return;
    const pano = map.getStreetView();
    if (!pano) return;
    const listener = pano.addListener('visible_changed', () => {
      onStreetViewStatus(pano.getVisible());
    });
    return () => listener.remove();
  }, [map, onStreetViewStatus]);

  // Render accurate GPS radius circles around located devices
  useEffect(() => {
    if (!map || !mapsLib) return;

    const currentIds = new Set<string>();
    devicesWithLocation.forEach((dev) => {
      const loc = dev.location!;
      currentIds.add(dev.deviceId);
      const isSelected = activeDevice?.deviceId === dev.deviceId;
      const center = { lat: loc.latitude, lng: loc.longitude };
      const radius = Math.max(4, Math.min(loc.accuracy || 10, 2500));

      const existing = circlesRef.current[dev.deviceId];
      if (existing) {
        existing.setCenter(center);
        existing.setRadius(radius);
        existing.setOptions({
          strokeColor: isSelected ? '#6366f1' : '#10b981',
          fillColor: isSelected ? '#6366f1' : '#10b981',
          fillOpacity: isSelected ? 0.16 : 0.1,
        });
      } else {
        circlesRef.current[dev.deviceId] = new mapsLib.Circle({
          map,
          center,
          radius,
          strokeColor: isSelected ? '#6366f1' : '#10b981',
          strokeOpacity: 0.75,
          strokeWeight: 1.5,
          fillColor: isSelected ? '#6366f1' : '#10b981',
          fillOpacity: isSelected ? 0.16 : 0.1,
          clickable: false,
        });
      }
    });

    Object.keys(circlesRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        circlesRef.current[id].setMap(null);
        delete circlesRef.current[id];
      }
    });
  }, [map, mapsLib, devicesWithLocation, activeDevice?.deviceId]);

  useEffect(() => {
    return () => {
      Object.values(circlesRef.current).forEach((c) => c.setMap(null));
      circlesRef.current = {};
    };
  }, []);

  // Follow active device coordinates when followActive is enabled
  useEffect(() => {
    if (!map || !followActive || !activeDevice?.location) return;
    const { latitude, longitude } = activeDevice.location;
    const coordKey = `${activeDevice.deviceId}:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    if (lastPannedCoordsRef.current !== coordKey) {
      lastPannedCoordsRef.current = coordKey;
      map.panTo({ lat: latitude, lng: longitude });
      const currentZoom = map.getZoom() ?? 4;
      if (currentZoom < 15) {
        map.setZoom(18);
      }
    }
  }, [map, followActive, activeDevice]);

  // Explicit recenter trigger
  useEffect(() => {
    if (!map || recenterSignal === lastRecenterSeqRef.current) return;
    lastRecenterSeqRef.current = recenterSignal;
    if (activeDevice?.location) {
      const target = {
        lat: activeDevice.location.latitude,
        lng: activeDevice.location.longitude,
      };
      const pano = map.getStreetView();
      if (pano && pano.getVisible()) {
        pano.setVisible(false);
      }
      map.panTo(target);
      map.setZoom(18);
    }
  }, [map, recenterSignal, activeDevice]);

  // Explicit zoom +/- trigger
  useEffect(() => {
    if (!map || zoomDeltaSignal.seq === lastZoomSeqRef.current) return;
    lastZoomSeqRef.current = zoomDeltaSignal.seq;
    const current = map.getZoom() ?? 15;
    const next = Math.max(2, Math.min(21, current + zoomDeltaSignal.delta));
    map.setZoom(next);
  }, [map, zoomDeltaSignal]);

  // Local browser area focus trigger (never mutates device location)
  useEffect(() => {
    if (!map || !localFocusTarget || localFocusTarget.seq === lastLocalFocusSeqRef.current) return;
    lastLocalFocusSeqRef.current = localFocusTarget.seq;
    map.panTo({ lat: localFocusTarget.lat, lng: localFocusTarget.lng });
    map.setZoom(15);
  }, [map, localFocusTarget]);

  // Street View toggle at exact device coordinates
  useEffect(() => {
    if (!map || streetViewSignal === lastStreetViewSeqRef.current) return;
    lastStreetViewSeqRef.current = streetViewSignal;

    const pano = map.getStreetView();
    if (!pano) return;

    if (pano.getVisible()) {
      pano.setVisible(false);
      onStreetViewStatus(false);
      return;
    }

    const targetLatLng = activeDevice?.location
      ? { lat: activeDevice.location.latitude, lng: activeDevice.location.longitude }
      : map.getCenter()?.toJSON();

    if (!targetLatLng) {
      onStreetViewStatus(false, 'No coordinates selected for Street View.');
      return;
    }

    if (streetViewLib?.StreetViewService) {
      const svService = new streetViewLib.StreetViewService();
      svService.getPanorama(
        { location: targetLatLng, radius: 100 },
        (data: any, status: string) => {
          if (status === 'OK' && data?.location?.latLng) {
            pano.setPosition(data.location.latLng);
            pano.setPov({ heading: activeDevice?.location?.heading ?? 0, pitch: 0 });
            pano.setVisible(true);
            onStreetViewStatus(true);
          } else {
            onStreetViewStatus(
              false,
              'No Street View imagery within 100m. Drag the yellow Pegman onto any blue road.'
            );
          }
        }
      );
    } else {
      pano.setPosition(targetLatLng);
      pano.setVisible(true);
      onStreetViewStatus(true);
    }
  }, [map, streetViewLib, streetViewSignal, activeDevice, onStreetViewStatus]);

  return null;
};

interface InteractiveFallbackMapProps {
  initialCenter: { lat: number; lng: number };
  initialZoom: number;
  mapType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain';
  devicesWithLocation: Device[];
  activeDevice: Device | null;
  followActive: boolean;
  recenterSignal: number;
  zoomDeltaSignal: { seq: number; delta: number };
  localFocusTarget: { lat: number; lng: number; seq: number } | null;
  onUserDragStart: () => void;
  onSelectDevice: (dev: Device) => void;
}

const escapeHtml = (unsafe: string): string =>
  unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const InteractiveFallbackMap: React.FC<InteractiveFallbackMapProps> = ({
  initialCenter,
  initialZoom,
  mapType,
  devicesWithLocation,
  activeDevice,
  followActive,
  recenterSignal,
  zoomDeltaSignal,
  localFocusTarget,
  onUserDragStart,
  onSelectDevice,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const labelLayerRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  const circlesRef = useRef<Record<string, L.Circle>>({});
  const lastPannedCoordsRef = useRef<string>('');
  const lastRecenterSeqRef = useRef<number>(0);
  const lastZoomSeqRef = useRef<number>(0);
  const lastLocalFocusSeqRef = useRef<number>(0);

  // Initialize interactive Leaflet map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const lMap = L.map(containerRef.current, {
      center: [initialCenter.lat, initialCenter.lng],
      zoom: initialZoom,
      zoomControl: false,
      attributionControl: true,
    });

    lMap.on('dragstart', () => {
      onUserDragStart();
    });

    mapRef.current = lMap;

    const resizeObserver = new ResizeObserver(() => {
      lMap.invalidateSize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      lMap.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      labelLayerRef.current = null;
      markersRef.current = {};
      circlesRef.current = {};
    };
  }, []);

  // Update tile layer when mapType changes
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap) return;

    if (tileLayerRef.current) {
      lMap.removeLayer(tileLayerRef.current);
      tileLayerRef.current = null;
    }
    if (labelLayerRef.current) {
      lMap.removeLayer(labelLayerRef.current);
      labelLayerRef.current = null;
    }

    if (mapType === 'satellite' || mapType === 'hybrid') {
      tileLayerRef.current = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxZoom: 19,
          attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics',
        }
      ).addTo(lMap);

      if (mapType === 'hybrid') {
        labelLayerRef.current = L.tileLayer(
          'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          {
            maxZoom: 19,
          }
        ).addTo(lMap);
      }
    } else if (mapType === 'terrain') {
      tileLayerRef.current = L.tileLayer(
        'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        {
          maxZoom: 17,
          attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap',
        }
      ).addTo(lMap);
    } else {
      tileLayerRef.current = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors',
        }
      ).addTo(lMap);
    }
  }, [mapType]);

  // Sync device markers and GPS precision accuracy circles
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap) return;

    const currentIds = new Set<string>();

    devicesWithLocation.forEach((dev) => {
      const loc = dev.location!;
      currentIds.add(dev.deviceId);
      const isSelected = activeDevice?.deviceId === dev.deviceId;
      const isOnline = dev.status === 'online' && !dev.isRevoked;
      const pos: L.LatLngExpression = [loc.latitude, loc.longitude];
      const radius = Math.max(4, Math.min(loc.accuracy || 10, 2500));

      // Precision radius circle
      const existingCircle = circlesRef.current[dev.deviceId];
      if (existingCircle) {
        existingCircle.setLatLng(pos);
        existingCircle.setRadius(radius);
        existingCircle.setStyle({
          color: isSelected ? '#6366f1' : '#10b981',
          fillColor: isSelected ? '#6366f1' : '#10b981',
          fillOpacity: isSelected ? 0.2 : 0.12,
        });
      } else {
        circlesRef.current[dev.deviceId] = L.circle(pos, {
          radius,
          color: isSelected ? '#6366f1' : '#10b981',
          weight: 1.5,
          opacity: 0.85,
          fillColor: isSelected ? '#6366f1' : '#10b981',
          fillOpacity: isSelected ? 0.2 : 0.12,
          interactive: false,
        }).addTo(lMap);
      }

      // Custom pulsing marker icon
      const badgeBg = isSelected ? '#4f46e5' : isOnline ? '#059669' : '#1e293b';
      const badgeBorder = isSelected ? '#a5b4fc' : isOnline ? '#34d399' : '#475569';
      const pulseColor = isOnline ? 'rgba(52, 211, 153, 0.55)' : 'rgba(99, 102, 241, 0.45)';
      const iconHtml = `
        <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);pointer-events:auto;">
          <div style="position:relative;display:flex;align-items:center;justify-content:center;">
            <span style="position:absolute;width:28px;height:28px;border-radius:9999px;background:${pulseColor};animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;"></span>
            <div style="position:relative;z-index:2;padding:4px 9px;border-radius:10px;background:${badgeBg};border:1.5px solid ${badgeBorder};color:#ffffff;font-family:system-ui,-apple-system,sans-serif;font-size:10px;font-weight:700;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,0.45);">
              ${escapeHtml(dev.deviceName)}
            </div>
          </div>
          <div style="margin-top:3px;padding:1px 6px;border-radius:6px;background:rgba(2,6,23,0.88);border:1px solid rgba(16,185,129,0.35);color:#6ee7b7;font-family:monospace;font-size:9px;white-space:nowrap;">
            ±${Math.round(loc.accuracy || 5)}m
          </div>
        </div>
      `;

      const icon = L.divIcon({
        html: iconHtml,
        className: 'beampair-leaflet-pin',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });

      const existingMarker = markersRef.current[dev.deviceId];
      if (existingMarker) {
        existingMarker.setLatLng(pos);
        existingMarker.setIcon(icon);
      } else {
        const marker = L.marker(pos, { icon }).addTo(lMap);
        marker.on('click', () => {
          onSelectDevice(dev);
        });
        markersRef.current[dev.deviceId] = marker;
      }
    });

    Object.keys(markersRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        lMap.removeLayer(markersRef.current[id]);
        delete markersRef.current[id];
      }
    });
    Object.keys(circlesRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        lMap.removeLayer(circlesRef.current[id]);
        delete circlesRef.current[id];
      }
    });
  }, [devicesWithLocation, activeDevice?.deviceId, onSelectDevice]);

  // Follow active device
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap || !followActive || !activeDevice?.location) return;
    const { latitude, longitude } = activeDevice.location;
    const coordKey = `${activeDevice.deviceId}:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    if (lastPannedCoordsRef.current !== coordKey) {
      lastPannedCoordsRef.current = coordKey;
      const targetZoom = Math.max(lMap.getZoom(), 17);
      lMap.flyTo([latitude, longitude], targetZoom, { duration: 0.6 });
    }
  }, [followActive, activeDevice]);

  // Recenter trigger
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap || recenterSignal === lastRecenterSeqRef.current) return;
    lastRecenterSeqRef.current = recenterSignal;
    if (activeDevice?.location) {
      lMap.flyTo([activeDevice.location.latitude, activeDevice.location.longitude], 18, {
        duration: 0.6,
      });
    }
  }, [recenterSignal, activeDevice]);

  // Zoom +/- trigger
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap || zoomDeltaSignal.seq === lastZoomSeqRef.current) return;
    lastZoomSeqRef.current = zoomDeltaSignal.seq;
    if (zoomDeltaSignal.delta > 0) {
      lMap.zoomIn();
    } else {
      lMap.zoomOut();
    }
  }, [zoomDeltaSignal]);

  // Local area focus trigger
  useEffect(() => {
    const lMap = mapRef.current;
    if (!lMap || !localFocusTarget || localFocusTarget.seq === lastLocalFocusSeqRef.current) return;
    lastLocalFocusSeqRef.current = localFocusTarget.seq;
    lMap.flyTo([localFocusTarget.lat, localFocusTarget.lng], 15, { duration: 0.6 });
  }, [localFocusTarget]);

  return <div ref={containerRef} className="w-full h-full z-0 bg-slate-900" />;
};

export const DeviceMapViewer: React.FC<DeviceMapViewerProps> = ({
  devices,
  selectedDeviceId,
  onSelectDevice,
  onRequestLocationPing,
  compact = false,
  className = '',
}) => {
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(
    selectedDeviceId || null
  );
  const [mapType, setMapType] = useState<'roadmap' | 'satellite' | 'hybrid' | 'terrain'>('hybrid');
  const [isPinging, setIsPinging] = useState<boolean>(false);
  const [pingSuccess, setPingSuccess] = useState<string | null>(null);
  const [copiedCoords, setCopiedCoords] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [fallbackReason, setFallbackReason] = useState<string | null>(() => {
    return typeof window !== 'undefined' ? (window as any).__gmpFallbackReason || null : null;
  });

  // Listen for global Google Maps fallback trigger (e.g., BillingNotEnabledMapError, OverQuotaMapError)
  useEffect(() => {
    const onFallback = (evt: Event) => {
      const detail = (evt as CustomEvent<{ reason?: string }>).detail;
      setFallbackReason(detail?.reason || 'error');
    };
    window.addEventListener('gmp-fallback-map', onFallback);
    return () => window.removeEventListener('gmp-fallback-map', onFallback);
  }, []);

  // Interactive camera & street-view controls state
  const [followActive, setFollowActive] = useState<boolean>(true);
  const [recenterSignal, setRecenterSignal] = useState<number>(0);
  const [zoomDeltaSignal, setZoomDeltaSignal] = useState<{ seq: number; delta: number }>({
    seq: 0,
    delta: 0,
  });
  const [streetViewSignal, setStreetViewSignal] = useState<number>(0);
  const [isStreetViewOpen, setIsStreetViewOpen] = useState<boolean>(false);
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [localFocusTarget, setLocalFocusTarget] = useState<{
    lat: number;
    lng: number;
    seq: number;
  } | null>(null);

  // Sync prop selection
  useEffect(() => {
    if (selectedDeviceId) {
      setActiveDeviceId(selectedDeviceId);
      setFollowActive(true);
      setRecenterSignal((s) => s + 1);
    } else if (devices.length > 0 && !activeDeviceId) {
      const withLoc = devices.find((d) => d.location);
      if (withLoc) {
        setActiveDeviceId(withLoc.deviceId);
      }
    }
  }, [selectedDeviceId, devices, activeDeviceId]);

  // Devices with valid coordinates
  const devicesWithLocation = useMemo(() => {
    return devices.filter(
      (d) =>
        d.location &&
        typeof d.location.latitude === 'number' &&
        typeof d.location.longitude === 'number' &&
        !isNaN(d.location.latitude) &&
        !isNaN(d.location.longitude)
    );
  }, [devices]);

  // Currently focused device
  const activeDevice = useMemo(() => {
    if (activeDeviceId) {
      return devices.find((d) => d.deviceId === activeDeviceId) || null;
    }
    return devicesWithLocation[0] || null;
  }, [devices, activeDeviceId, devicesWithLocation]);

  // Initial Center & Zoom
  const initialCenter = useMemo(() => {
    if (activeDevice?.location) {
      return {
        lat: activeDevice.location.latitude,
        lng: activeDevice.location.longitude,
      };
    }
    if (devicesWithLocation.length > 0) {
      return {
        lat: devicesWithLocation[0].location!.latitude,
        lng: devicesWithLocation[0].location!.longitude,
      };
    }
    return { lat: 20.5937, lng: 78.9629 };
  }, []);

  const initialZoom = activeDevice?.location || devicesWithLocation.length > 0 ? 18 : 3;

  const showNotice = useCallback((msg: string) => {
    setMapNotice(msg);
    setTimeout(() => {
      setMapNotice((curr) => (curr === msg ? null : curr));
    }, 4500);
  }, []);

  const handleUserDragStart = useCallback(() => {
    setFollowActive(false);
  }, []);

  const handleStreetViewStatus = useCallback(
    (active: boolean, notice?: string) => {
      setIsStreetViewOpen(active);
      if (notice) showNotice(notice);
    },
    [showNotice]
  );

  // Request fresh GPS ping
  const handlePing = async (devId: string) => {
    if (!onRequestLocationPing) return;
    setIsPinging(true);
    setPingSuccess(null);
    try {
      await onRequestLocationPing(devId);
      setPingSuccess('GPS ping sent — waiting for fresh coordinates');
      setFollowActive(true);
      setTimeout(() => setPingSuccess(null), 3500);
    } catch (err) {
      console.warn('Ping error:', err);
    } finally {
      setIsPinging(false);
    }
  };

  // Pan map locally to the Admin browser's area for orientation
  const handleCenterOnMyArea = () => {
    if (!('geolocation' in navigator)) {
      showNotice('Browser geolocation unavailable.');
      return;
    }
    setFollowActive(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocalFocusTarget((prev) => ({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          seq: (prev?.seq ?? 0) + 1,
        }));
      },
      () => showNotice('Allow browser location to preview your local area.'),
      { enableHighAccuracy: false, timeout: 6000 }
    );
  };

  // Copy coordinates
  const handleCopyCoords = (loc: DeviceLocation) => {
    const text = `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`;
    navigator.clipboard.writeText(text);
    setCopiedCoords(true);
    setTimeout(() => setCopiedCoords(false), 2000);
  };

  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || '';
  const hasApiKey = Boolean(apiKey && apiKey.trim().length > 0);
  const useGoogleMaps = hasApiKey && !fallbackReason;

  return (
    <div
      className={`relative flex flex-col bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl ${
        compact ? 'h-[360px]' : isFullscreen ? 'fixed inset-0 z-50 rounded-none' : 'h-[640px]'
      } ${className}`}
    >
      {/* Top Map Toolbar */}
      <div className="bg-slate-900/95 border-b border-slate-800 px-3 sm:px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 z-20 shrink-0">
        <div className="flex items-center space-x-2.5">
          <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl">
            <LocateFixed className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-xs font-bold text-white tracking-wide">
                Live Device GPS Map
              </h3>
              <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[9px] font-mono rounded-full font-semibold flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>{devicesWithLocation.length} Located</span>
              </span>
            </div>
            <p className="text-[10px] text-slate-400 hidden sm:block">
              Drag to pan, scroll to zoom, and switch between Satellite, Hybrid & Street views
            </p>
          </div>
        </div>

        {/* Toolbar Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Map Layer Switcher */}
          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl p-0.5 text-[10px]">
            {(['roadmap', 'satellite', 'hybrid', 'terrain'] as const).map((layer) => (
              <button
                key={layer}
                type="button"
                onClick={() => setMapType(layer)}
                className={`px-2 py-1 rounded-lg font-medium capitalize transition cursor-pointer ${
                  mapType === layer ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {layer === 'roadmap' ? 'Road' : layer}
              </button>
            ))}
          </div>

          {/* Center on Device / Follow Toggle */}
          {activeDevice?.location && (
            <button
              type="button"
              onClick={() => {
                setFollowActive(true);
                setRecenterSignal((s) => s + 1);
              }}
              className={`px-2.5 py-1.5 rounded-xl text-[10px] font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                followActive
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
              }`}
              title="Center map on selected phone and follow live updates"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>{followActive ? 'Following' : 'Re-center'}</span>
            </button>
          )}

          {/* 360 Street View Button (when Google Maps API active) */}
          {!compact && useGoogleMaps && (
            <button
              type="button"
              onClick={() => setStreetViewSignal((s) => s + 1)}
              className={`px-2.5 py-1.5 rounded-xl text-[10px] font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                isStreetViewOpen
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
              }`}
              title="Inspect Street View at exact phone coordinates"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{isStreetViewOpen ? 'Exit Street View' : 'Street View'}</span>
            </button>
          )}

          {!compact && (
            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition cursor-pointer border border-slate-700"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Map'}
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Main Map Canvas Area */}
      <div className="flex-1 relative overflow-hidden bg-slate-900 min-h-[260px]">
        {useGoogleMaps ? (
          <APIProvider
            apiKey={apiKey}
            libraries={['marker', 'maps', 'streetView']}
            onError={(err) => {
              console.warn('Google Maps API load notice:', err);
              (window as any).__gmpFallbackReason = 'error';
              setFallbackReason('error');
            }}
          >
            <GoogleMap
              mapId="DEMO_MAP_ID"
              defaultCenter={initialCenter}
              defaultZoom={initialZoom}
              mapTypeId={mapType}
              gestureHandling="greedy"
              disableDefaultUI={compact}
              mapTypeControl={false}
              fullscreenControl={false}
              streetViewControl={!compact}
              zoomControl={false}
              internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
              className="w-full h-full"
            >
              <MapController
                devicesWithLocation={devicesWithLocation}
                activeDevice={activeDevice}
                followActive={followActive}
                onUserDragStart={handleUserDragStart}
                recenterSignal={recenterSignal}
                zoomDeltaSignal={zoomDeltaSignal}
                streetViewSignal={streetViewSignal}
                localFocusTarget={localFocusTarget}
                onStreetViewStatus={handleStreetViewStatus}
              />

              {devicesWithLocation.map((dev) => {
                const loc = dev.location!;
                const isSelected = activeDevice?.deviceId === dev.deviceId;
                const isOnline = dev.status === 'online' && !dev.isRevoked;

                return (
                  <AdvancedMarker
                    key={dev.deviceId}
                    position={{ lat: loc.latitude, lng: loc.longitude }}
                    title={`${dev.deviceName} (±${loc.accuracy}m)`}
                    onClick={() => {
                      setActiveDeviceId(dev.deviceId);
                      setFollowActive(true);
                      setRecenterSignal((s) => s + 1);
                      if (onSelectDevice) onSelectDevice(dev);
                    }}
                  >
                    <div className="relative group cursor-pointer flex flex-col items-center">
                      <span
                        className={`absolute w-9 h-9 rounded-full opacity-60 animate-ping ${
                          isOnline ? 'bg-emerald-400' : 'bg-indigo-400'
                        }`}
                      />
                      <div
                        className={`relative z-10 px-2.5 py-1.5 rounded-xl text-white font-bold text-[10px] flex items-center space-x-1.5 shadow-xl border ${
                          isSelected
                            ? 'bg-indigo-600 border-indigo-300 ring-2 ring-indigo-400/50 scale-110'
                            : isOnline
                            ? 'bg-emerald-600 border-emerald-400'
                            : 'bg-slate-800 border-slate-600'
                        } transition-transform duration-200`}
                      >
                        <Smartphone className="w-3 h-3" />
                        <span className="truncate max-w-[120px]">{dev.deviceName}</span>
                      </div>
                      <div className="mt-1 px-1.5 py-0.5 bg-black/85 backdrop-blur-xs text-[9px] text-emerald-300 rounded-md font-mono border border-emerald-500/30 whitespace-nowrap">
                        ±{loc.accuracy}m
                      </div>
                    </div>
                  </AdvancedMarker>
                );
              })}
            </GoogleMap>
          </APIProvider>
        ) : (
          <InteractiveFallbackMap
            initialCenter={initialCenter}
            initialZoom={initialZoom}
            mapType={mapType}
            devicesWithLocation={devicesWithLocation}
            activeDevice={activeDevice}
            followActive={followActive}
            recenterSignal={recenterSignal}
            zoomDeltaSignal={zoomDeltaSignal}
            localFocusTarget={localFocusTarget}
            onUserDragStart={handleUserDragStart}
            onSelectDevice={(dev) => {
              setActiveDeviceId(dev.deviceId);
              setFollowActive(true);
              setRecenterSignal((s) => s + 1);
              if (onSelectDevice) onSelectDevice(dev);
            }}
          />
        )}

        {/* Quick Interactive Zoom & Orientation Controls (Top-Left) */}
        {!isStreetViewOpen && (
          <div className="absolute top-3 left-3 z-[400] flex flex-col space-y-1.5">
            <div className="flex flex-col bg-slate-950/90 backdrop-blur-md border border-slate-800 rounded-xl overflow-hidden shadow-xl">
              <button
                type="button"
                onClick={() => setZoomDeltaSignal((prev) => ({ seq: prev.seq + 1, delta: 1 }))}
                className="p-2 text-slate-200 hover:text-white hover:bg-slate-800 transition cursor-pointer border-b border-slate-800"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoomDeltaSignal((prev) => ({ seq: prev.seq + 1, delta: -1 }))}
                className="p-2 text-slate-200 hover:text-white hover:bg-slate-800 transition cursor-pointer"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
            </div>

            {activeDevice?.location ? (
              <button
                type="button"
                onClick={() => {
                  setFollowActive(true);
                  setRecenterSignal((s) => s + 1);
                }}
                className={`p-2 rounded-xl border shadow-xl transition cursor-pointer ${
                  followActive
                    ? 'bg-indigo-600 text-white border-indigo-400'
                    : 'bg-slate-950/90 text-slate-200 hover:text-white hover:bg-slate-800 border-slate-800'
                }`}
                title="Jump to exact phone location"
              >
                <Navigation className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCenterOnMyArea}
                className="p-2 bg-slate-950/90 text-slate-200 hover:text-white hover:bg-slate-800 rounded-xl border border-slate-800 shadow-xl transition cursor-pointer"
                title="Pan map to my area"
              >
                <Compass className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Billing / Fallback Notice Pill (non-blocking) */}
        {fallbackReason === 'billing' && !compact && (
          <div className="absolute top-3 left-14 z-[400] px-3 py-1.5 bg-slate-950/90 backdrop-blur-md border border-slate-700 text-slate-300 text-[10px] rounded-xl shadow-lg flex items-center space-x-2">
            <span>Satellite &amp; Street tiles active (Google Cloud Billing inactive on key)</span>
            <a
              href="https://console.cloud.google.com/project/_/billing/enable"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline font-semibold whitespace-nowrap"
            >
              Enable Billing
            </a>
          </div>
        )}

        {/* Map Status / Street View Toast Notice */}
        {mapNotice && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[450] px-3.5 py-2 bg-slate-950/95 border border-amber-500/40 text-amber-200 text-[11px] rounded-xl shadow-2xl flex items-center space-x-2 max-w-sm text-center">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>{mapNotice}</span>
          </div>
        )}

        {/* Non-blocking Awaiting GPS Notice when active device has no coordinates yet */}
        {activeDevice && !activeDevice.location && (
          <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:max-w-sm bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-2xl p-4 shadow-2xl space-y-2.5 z-[400]">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <MapPin className="w-4 h-4 text-amber-400" />
                <span className="text-xs font-bold text-white">{activeDevice.deviceName}</span>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
                Awaiting GPS Fix
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This phone has not reported GPS coordinates yet. Ensure Location permission is allowed on the phone, then request a ping.
            </p>
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => handlePing(activeDevice.deviceId)}
                disabled={isPinging}
                className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[11px] font-semibold rounded-lg flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${isPinging ? 'animate-spin' : ''}`} />
                <span>{isPinging ? 'Pinging Phone...' : 'Request GPS Ping'}</span>
              </button>
              <button
                type="button"
                onClick={handleCenterOnMyArea}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] rounded-lg border border-slate-700 cursor-pointer"
              >
                My Area
              </button>
            </div>
          </div>
        )}

        {/* Selected Device Telemetry Floating Overlay Card */}
        {activeDevice && activeDevice.location && !isStreetViewOpen && (
          <div className="absolute bottom-4 left-4 right-4 sm:right-auto sm:w-80 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-2xl p-3.5 shadow-2xl space-y-2.5 z-[400]">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-2">
                <div className="p-1.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 rounded-xl">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white tracking-wide">
                    {activeDevice.deviceName}
                  </h4>
                  <span className="text-[10px] text-slate-400 font-mono">
                    ID: {activeDevice.deviceId.substring(0, 14)}...
                  </span>
                </div>
              </div>

              <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-semibold rounded-full flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>±{activeDevice.location.accuracy}m</span>
              </span>
            </div>

            {/* Coordinates Grid */}
            <div className="grid grid-cols-2 gap-2 p-2 bg-slate-900/80 border border-slate-800/80 rounded-xl text-xs font-mono">
              <div>
                <span className="text-[9px] text-slate-500 block uppercase">Latitude</span>
                <span className="text-white font-bold text-[11px]">
                  {activeDevice.location.latitude.toFixed(6)}°
                </span>
              </div>
              <div>
                <span className="text-[9px] text-slate-500 block uppercase">Longitude</span>
                <span className="text-white font-bold text-[11px]">
                  {activeDevice.location.longitude.toFixed(6)}°
                </span>
              </div>
            </div>

            {/* Additional Telemetry Details */}
            {!compact && (
              <div className="text-[11px] text-slate-400 space-y-1">
                <div className="flex justify-between items-center">
                  <span>Speed / Heading:</span>
                  <span className="text-slate-300 font-mono">
                    {activeDevice.location.speed !== null && activeDevice.location.speed !== undefined
                      ? `${(activeDevice.location.speed * 3.6).toFixed(1)} km/h`
                      : 'Stationary'}
                    {activeDevice.location.heading !== null && activeDevice.location.heading !== undefined
                      ? ` (${Math.round(activeDevice.location.heading)}°)`
                      : ''}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span>Altitude:</span>
                  <span className="text-slate-300 font-mono">
                    {activeDevice.location.altitude !== null && activeDevice.location.altitude !== undefined
                      ? `${activeDevice.location.altitude.toFixed(1)} m ASL`
                      : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span>Last Updated:</span>
                  <span className="text-slate-300 font-mono">
                    {new Date(activeDevice.location.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}

            {pingSuccess && (
              <div className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] rounded-lg text-center font-medium">
                {pingSuccess}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center space-x-1.5 pt-1 border-t border-slate-800">
              <button
                type="button"
                onClick={() => handlePing(activeDevice.deviceId)}
                disabled={isPinging}
                className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-semibold rounded-lg flex items-center justify-center space-x-1 transition cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${isPinging ? 'animate-spin' : ''}`} />
                <span>{isPinging ? 'Pinging...' : 'Ping GPS'}</span>
              </button>

              <button
                type="button"
                onClick={() => handleCopyCoords(activeDevice.location!)}
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] rounded-lg transition border border-slate-700 cursor-pointer"
                title="Copy Latitude, Longitude"
              >
                {copiedCoords ? 'Copied!' : 'Copy'}
              </button>

              <a
                href={`https://www.google.com/maps/search/?api=1&query=${activeDevice.location.latitude},${activeDevice.location.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition border border-slate-700 cursor-pointer"
                title="Open in Google Maps"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        )}

        {/* Devices List Drawer on the Right (Desktop only) */}
        {!compact && !isStreetViewOpen && devices.length > 0 && (
          <div className="hidden lg:flex flex-col absolute top-3 right-3 w-64 max-h-[calc(100%-9rem)] bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-[400]">
            <div className="px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-bold text-white">Paired Devices</span>
              <span className="text-[10px] text-slate-400 font-mono font-semibold">
                {devices.length} Total
              </span>
            </div>

            <div className="p-2 space-y-1.5 overflow-y-auto max-h-60">
              {devices.map((d) => {
                const isSelected = activeDevice?.deviceId === d.deviceId;
                const hasLoc = !!d.location;
                return (
                  <button
                    key={d.deviceId}
                    type="button"
                    onClick={() => {
                      setActiveDeviceId(d.deviceId);
                      setFollowActive(true);
                      setRecenterSignal((s) => s + 1);
                      if (onSelectDevice) onSelectDevice(d);
                    }}
                    className={`w-full text-left p-2.5 rounded-xl text-xs transition cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-indigo-600/30 border border-indigo-500/50 text-white'
                        : 'bg-slate-900/60 border border-slate-800/80 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <div className="truncate pr-2">
                      <span className="font-semibold block truncate">{d.deviceName}</span>
                      <span className="text-[10px] text-slate-400 font-mono block">
                        {hasLoc ? `±${d.location!.accuracy}m GPS` : 'No GPS Fix'}
                      </span>
                    </div>

                    <div className="shrink-0 flex items-center space-x-1">
                      {hasLoc ? (
                        <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5 text-slate-500" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
