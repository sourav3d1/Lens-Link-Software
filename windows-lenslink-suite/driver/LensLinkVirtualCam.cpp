#include "LensLinkVirtualCam.h"
#include <algorithm>
#include <cstring>

struct LensLinkFormatPreset {
    int width;
    int height;
    int fps;
};

static const LensLinkFormatPreset kSupportedFormats[] = {
    {1920, 1080, 30},
    {1920, 1080, 60},
    {1280,  720, 30},
    {1280,  720, 60},
    { 854,  480, 30},
    {3840, 2160, 30},
};
static constexpr int kNumSupportedFormats = sizeof(kSupportedFormats) / sizeof(kSupportedFormats[0]);

// DirectShow Filter Registration Metadata
const AMOVIESETUP_MEDIATYPE sudPinTypes = {
    &MEDIATYPE_Video,
    &MEDIASUBTYPE_RGB24
};

const AMOVIESETUP_PIN sudOutputPin = {
    const_cast<LPWSTR>(L"Output"),
    FALSE,  // bRendered
    TRUE,   // bOutput
    FALSE,  // bZero
    FALSE,  // bMany
    &CLSID_NULL,
    nullptr,
    1,
    &sudPinTypes
};

const AMOVIESETUP_FILTER sudLensLinkFilter = {
    &CLSID_LensLinkWirelessWebcam,
    LENSLINK_DEVICE_NAME,
    MERIT_DO_NOT_USE,
    1,
    &sudOutputPin
};

CFactoryTemplate g_Templates[] = {
    {
        LENSLINK_DEVICE_NAME,
        &CLSID_LensLinkWirelessWebcam,
        CLensLinkVirtualCam::CreateInstance,
        nullptr,
        &sudLensLinkFilter
    }
};
int g_cTemplates = sizeof(g_Templates) / sizeof(g_Templates[0]);

// ============================================================================
// CLensLinkVirtualCam Filter Implementation
// ============================================================================

CUnknown* WINAPI CLensLinkVirtualCam::CreateInstance(LPUNKNOWN lpunk, HRESULT* phr) {
    auto* pNewFilter = new CLensLinkVirtualCam(lpunk, phr);
    if (!pNewFilter && phr) {
        *phr = E_OUTOFMEMORY;
    }
    return pNewFilter;
}

CLensLinkVirtualCam::CLensLinkVirtualCam(LPUNKNOWN lpunk, HRESULT* phr)
    : CSource(NAME("LensLink Wireless Webcam"), lpunk, CLSID_LensLinkWirelessWebcam) {
    new CLensLinkVirtualCamPin(phr, this, L"Capture");
}

STDMETHODIMP CLensLinkVirtualCam::QueryInterface(REFIID riid, void** ppv) {
    if (riid == _uuidof(IAMStreamConfig) || riid == _uuidof(IKsPropertySet)) {
        return m_paStreams[0]->QueryInterface(riid, ppv);
    }
    return CSource::QueryInterface(riid, ppv);
}

// ============================================================================
// CLensLinkVirtualCamPin Output Pin Implementation
// ============================================================================

CLensLinkVirtualCamPin::CLensLinkVirtualCamPin(HRESULT* phr, CSource* pParent, LPCWSTR pPinName)
    : CSourceStream(NAME("LensLink Capture Pin"), phr, pParent, pPinName) {
    OpenSharedMemory();
}

CLensLinkVirtualCamPin::~CLensLinkVirtualCamPin() {
    CloseSharedMemory();
}

void CLensLinkVirtualCamPin::OpenSharedMemory() {
    if (!m_hMutex) {
        m_hMutex = CreateMutexW(nullptr, FALSE, LENSLINK_MUTEX_NAME);
    }
    if (!m_hMapFile) {
        m_hMapFile = CreateFileMappingW(
            INVALID_HANDLE_VALUE,
            nullptr,
            PAGE_READWRITE,
            0,
            static_cast<DWORD>(LENSLINK_SHMEM_TOTAL_BYTES),
            LENSLINK_SHMEM_NAME
        );
    }
    if (m_hMapFile && !m_pSharedBuf) {
        m_pSharedBuf = static_cast<BYTE*>(
            MapViewOfFile(m_hMapFile, FILE_MAP_READ, 0, 0, LENSLINK_SHMEM_TOTAL_BYTES)
        );
    }
}

void CLensLinkVirtualCamPin::CloseSharedMemory() {
    if (m_pSharedBuf) {
        UnmapViewOfFile(m_pSharedBuf);
        m_pSharedBuf = nullptr;
    }
    if (m_hMapFile) {
        CloseHandle(m_hMapFile);
        m_hMapFile = nullptr;
    }
    if (m_hMutex) {
        CloseHandle(m_hMutex);
        m_hMutex = nullptr;
    }
}

STDMETHODIMP CLensLinkVirtualCamPin::NonDelegatingQueryInterface(REFIID riid, void** ppv) {
    if (riid == _uuidof(IAMStreamConfig)) {
        return GetInterface(static_cast<IAMStreamConfig*>(this), ppv);
    }
    if (riid == _uuidof(IKsPropertySet)) {
        return GetInterface(static_cast<IKsPropertySet*>(this), ppv);
    }
    return CSourceStream::NonDelegatingQueryInterface(riid, ppv);
}

HRESULT CLensLinkVirtualCamPin::OnThreadCreate() {
    m_rtLastTime = 0;
    OpenSharedMemory();
    return S_OK;
}

HRESULT CLensLinkVirtualCamPin::GetMediaType(int iPosition, CMediaType* pMediaType) {
    CheckPointer(pMediaType, E_POINTER);
    if (iPosition < 0) return E_INVALIDARG;
    if (iPosition >= kNumSupportedFormats) return VFW_S_NO_MORE_ITEMS;

    const auto& fmt = kSupportedFormats[iPosition];
    auto* pvi = reinterpret_cast<VIDEOINFOHEADER*>(
        pMediaType->AllocFormatBuffer(sizeof(VIDEOINFOHEADER))
    );
    if (!pvi) return E_OUTOFMEMORY;

    ZeroMemory(pvi, sizeof(VIDEOINFOHEADER));
    pvi->AvgTimePerFrame = UNITS / fmt.fps;
    pvi->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    pvi->bmiHeader.biWidth = fmt.width;
    pvi->bmiHeader.biHeight = fmt.height; // Bottom-up DIB standard for RGB24
    pvi->bmiHeader.biPlanes = 1;
    pvi->bmiHeader.biBitCount = 24;
    pvi->bmiHeader.biCompression = BI_RGB;
    pvi->bmiHeader.biSizeImage = GetBitmapSize(&pvi->bmiHeader);
    pvi->dwBitRate = static_cast<DWORD>(pvi->bmiHeader.biSizeImage) * 8 * fmt.fps;

    SetRectEmpty(&pvi->rcSource);
    SetRectEmpty(&pvi->rcTarget);

    pMediaType->SetType(&MEDIATYPE_Video);
    pMediaType->SetFormatType(&FORMAT_VideoInfo);
    pMediaType->SetTemporalCompression(FALSE);
    pMediaType->SetSubtype(&MEDIASUBTYPE_RGB24);
    pMediaType->SetSampleSize(pvi->bmiHeader.biSizeImage);
    return S_OK;
}

HRESULT CLensLinkVirtualCamPin::CheckMediaType(const CMediaType* pMediaType) {
    CheckPointer(pMediaType, E_POINTER);
    if (*pMediaType->Type() != MEDIATYPE_Video) return E_INVALIDARG;
    if (*pMediaType->Subtype() != MEDIASUBTYPE_RGB24) return E_INVALIDARG;
    if (*pMediaType->FormatType() != FORMAT_VideoInfo) return E_INVALIDARG;
    auto* pvi = reinterpret_cast<VIDEOINFOHEADER*>(pMediaType->Format());
    if (!pvi || pvi->bmiHeader.biBitCount != 24) return E_INVALIDARG;
    return S_OK;
}

HRESULT CLensLinkVirtualCamPin::SetMediaType(const CMediaType* pMediaType) {
    HRESULT hr = CSourceStream::SetMediaType(pMediaType);
    if (SUCCEEDED(hr)) {
        auto* pvi = reinterpret_cast<VIDEOINFOHEADER*>(pMediaType->Format());
        if (pvi) {
            m_width = pvi->bmiHeader.biWidth;
            m_height = std::abs(pvi->bmiHeader.biHeight);
            m_rtFrameLength = pvi->AvgTimePerFrame > 0 ? pvi->AvgTimePerFrame : (UNITS / 30);
            m_fps = static_cast<int>(UNITS / m_rtFrameLength);
        }
    }
    return hr;
}

HRESULT CLensLinkVirtualCamPin::DecideBufferSize(IMemAllocator* pAlloc, ALLOCATOR_PROPERTIES* pRequest) {
    CheckPointer(pAlloc, E_POINTER);
    CheckPointer(pRequest, E_POINTER);

    auto* pvi = reinterpret_cast<VIDEOINFOHEADER*>(m_mt.Format());
    pRequest->cBuffers = 2;
    pRequest->cbBuffer = pvi ? pvi->bmiHeader.biSizeImage : (m_width * m_height * 3);

    ALLOCATOR_PROPERTIES actual{};
    HRESULT hr = pAlloc->SetProperties(pRequest, &actual);
    if (FAILED(hr)) return hr;
    return (actual.cbBuffer < pRequest->cbBuffer) ? E_FAIL : S_OK;
}

void CLensLinkVirtualCamPin::RenderStandbyFrame(BYTE* dst, int width, int height) {
    const int stride = width * 3;
    for (int y = 0; y < height; ++y) {
        BYTE* row = dst + y * stride;
        const bool accentBand = (y >= height / 2 - 4 && y <= height / 2 + 4);
        const BYTE b = accentBand ? 0xD8 : 0x2A;
        const BYTE g = accentBand ? 0x4E : 0x17;
        const BYTE r = accentBand ? 0x1D : 0x0F;
        for (int x = 0; x < width; ++x) {
            row[x * 3 + 0] = b;
            row[x * 3 + 1] = g;
            row[x * 3 + 2] = r;
        }
    }
}

HRESULT CLensLinkVirtualCamPin::FillBuffer(IMediaSample* pms) {
    CheckPointer(pms, E_POINTER);
    BYTE* pData = nullptr;
    pms->GetPointer(&pData);
    const long cbData = pms->GetSize();

    const DWORD sleepMs = static_cast<DWORD>(m_rtFrameLength / 10000);
    if (sleepMs > 0 && sleepMs < 100) {
        Sleep(sleepMs);
    }

    REFERENCE_TIME rtStart = m_rtLastTime;
    m_rtLastTime += m_rtFrameLength;
    pms->SetTime(&rtStart, &m_rtLastTime);
    pms->SetSyncPoint(TRUE);

    const long expectedBytes = static_cast<long>(m_width) * m_height * 3;
    if (cbData < expectedBytes) return E_FAIL;

    bool copiedLive = false;
    if (m_pSharedBuf && m_hMutex) {
        if (WaitForSingleObject(m_hMutex, 12) == WAIT_OBJECT_0) {
            const auto* hdr = reinterpret_cast<const LensLinkSharedFrameHeader*>(m_pSharedBuf);
            if (hdr->magic == LENSLINK_SHMEM_MAGIC && hdr->phoneConnected == 1 &&
                hdr->width > 0 && hdr->height > 0) {
                const BYTE* srcPixels = m_pSharedBuf + sizeof(LensLinkSharedFrameHeader);
                const int srcW = static_cast<int>(hdr->width);
                const int srcH = static_cast<int>(hdr->height);

                for (int dy = 0; dy < m_height; ++dy) {
                    const int sy = (m_height - 1 - dy) * srcH / m_height;
                    const BYTE* srcRow = srcPixels + sy * srcW * 3;
                    BYTE* dstRow = pData + dy * m_width * 3;
                    for (int dx = 0; dx < m_width; ++dx) {
                        const int sx = dx * srcW / m_width;
                        dstRow[dx * 3 + 0] = srcRow[sx * 3 + 2]; // B
                        dstRow[dx * 3 + 1] = srcRow[sx * 3 + 1]; // G
                        dstRow[dx * 3 + 2] = srcRow[sx * 3 + 0]; // R
                    }
                }
                copiedLive = true;
            }
            ReleaseMutex(m_hMutex);
        }
    }

    if (!copiedLive) {
        RenderStandbyFrame(pData, m_width, m_height);
    }

    pms->SetActualDataLength(expectedBytes);
    return S_OK;
}

// ============================================================================
// IAMStreamConfig
// ============================================================================

STDMETHODIMP CLensLinkVirtualCamPin::SetFormat(AM_MEDIA_TYPE* pmt) {
    CheckPointer(pmt, E_POINTER);
    m_mt = *pmt;
    return SetMediaType(&m_mt);
}

STDMETHODIMP CLensLinkVirtualCamPin::GetFormat(AM_MEDIA_TYPE** ppmt) {
    CheckPointer(ppmt, E_POINTER);
    *ppmt = CreateMediaType(&m_mt);
    return (*ppmt) ? S_OK : E_OUTOFMEMORY;
}

STDMETHODIMP CLensLinkVirtualCamPin::GetNumberOfCapabilities(int* piCount, int* piSize) {
    CheckPointer(piCount, E_POINTER);
    CheckPointer(piSize, E_POINTER);
    *piCount = kNumSupportedFormats;
    *piSize = sizeof(VIDEO_STREAM_CONFIG_CAPS);
    return S_OK;
}

STDMETHODIMP CLensLinkVirtualCamPin::GetStreamCaps(int iIndex, AM_MEDIA_TYPE** pmt, BYTE* pSCC) {
    if (iIndex < 0 || iIndex >= kNumSupportedFormats) return S_FALSE;
    CMediaType mt;
    HRESULT hr = GetMediaType(iIndex, &mt);
    if (FAILED(hr)) return hr;
    *pmt = CreateMediaType(&mt);

    const auto& fmt = kSupportedFormats[iIndex];
    auto* scc = reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(pSCC);
    ZeroMemory(scc, sizeof(VIDEO_STREAM_CONFIG_CAPS));
    scc->guid = FORMAT_VideoInfo;
    scc->VideoStandard = AnalogVideo_None;
    scc->InputSize.cx = fmt.width;
    scc->InputSize.cy = fmt.height;
    scc->MinCroppingSize = scc->InputSize;
    scc->MaxCroppingSize = scc->InputSize;
    scc->MinOutputSize = scc->InputSize;
    scc->MaxOutputSize = scc->InputSize;
    scc->MinFrameInterval = UNITS / 60;
    scc->MaxFrameInterval = UNITS / 24;
    scc->MinBitsPerSecond = 854 * 480 * 24 * 24;
    scc->MaxBitsPerSecond = 3840 * 2160 * 24 * 30;
    return S_OK;
}

// ============================================================================
// IKsPropertySet
// ============================================================================

STDMETHODIMP CLensLinkVirtualCamPin::Set(REFGUID, DWORD, void*, DWORD, void*, DWORD) {
    return E_NOTIMPL;
}

STDMETHODIMP CLensLinkVirtualCamPin::Get(
    REFGUID guidPropSet, DWORD dwID, void*, DWORD,
    void* pPropData, DWORD cbPropData, DWORD* pcbReturned) {
    if (guidPropSet != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
    if (dwID != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
    if (!pPropData && !pcbReturned) return E_POINTER;
    if (pcbReturned) *pcbReturned = sizeof(GUID);
    if (!pPropData) return S_OK;
    if (cbPropData < sizeof(GUID)) return E_UNEXPECTED;
    *reinterpret_cast<GUID*>(pPropData) = PIN_CATEGORY_CAPTURE;
    return S_OK;
}

STDMETHODIMP CLensLinkVirtualCamPin::QuerySupported(REFGUID guidPropSet, DWORD dwID, DWORD* pTypeSupport) {
    if (guidPropSet != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
    if (dwID != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
    if (pTypeSupport) *pTypeSupport = KSPROPERTY_SUPPORT_GET;
    return S_OK;
}

// ============================================================================
// COM / DirectShow Registration Entry Points (regsvr32 LensLinkVirtualCam.ax)
// ============================================================================

static HRESULT RegisterLensLinkFilter(BOOL bRegister) {
    HRESULT hr = CoInitialize(nullptr);
    const bool didInit = SUCCEEDED(hr);

    IFilterMapper2* pFM2 = nullptr;
    hr = CoCreateInstance(
        CLSID_FilterMapper2, nullptr, CLSCTX_INPROC_SERVER,
        IID_IFilterMapper2, reinterpret_cast<void**>(&pFM2)
    );
    if (SUCCEEDED(hr) && pFM2) {
        if (bRegister) {
            REGFILTER2 rf2{};
            rf2.dwVersion = 1;
            rf2.dwMerit = MERIT_DO_NOT_USE;
            rf2.cPins = 1;
            REGFILTERPINS pin{};
            pin.strName = const_cast<LPWSTR>(L"Capture");
            pin.bRendered = FALSE;
            pin.bOutput = TRUE;
            pin.bZero = FALSE;
            pin.bMany = FALSE;
            pin.clsConnectsToFilter = &CLSID_NULL;
            pin.strConnectsToPin = nullptr;
            pin.nMediaTypes = 1;
            REGPINTYPES pinType = { &MEDIATYPE_Video, &MEDIASUBTYPE_RGB24 };
            pin.lpMediaType = &pinType;
            rf2.rgPins = &pin;

            hr = pFM2->RegisterFilter(
                CLSID_LensLinkWirelessWebcam,
                LENSLINK_DEVICE_NAME,
                nullptr,
                &CLSID_VideoInputDeviceCategory,
                LENSLINK_DEVICE_NAME,
                &rf2
            );
        } else {
            hr = pFM2->UnregisterFilter(
                &CLSID_VideoInputDeviceCategory,
                LENSLINK_DEVICE_NAME,
                CLSID_LensLinkWirelessWebcam
            );
        }
        pFM2->Release();
    }

    if (didInit) CoUninitialize();
    return hr;
}

STDAPI DllRegisterServer() {
    HRESULT hr = AMovieDllRegisterServer2(TRUE);
    if (FAILED(hr)) return hr;
    return RegisterLensLinkFilter(TRUE);
}

STDAPI DllUnregisterServer() {
    RegisterLensLinkFilter(FALSE);
    return AMovieDllRegisterServer2(FALSE);
}

extern "C" BOOL WINAPI DllEntryPoint(HINSTANCE, ULONG, LPVOID);

BOOL APIENTRY DllMain(HANDLE hModule, DWORD dwReason, LPVOID lpReserved) {
    return DllEntryPoint(static_cast<HINSTANCE>(hModule), dwReason, lpReserved);
}
